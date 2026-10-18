import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { auditMcpConfigs, BrowserController, BrowserLifecycleError, CONNECTION_NOTICE, SETUP_PROMPT } from "./controller.ts";
import { BrowserPreferences } from "./preferences.ts";

export const REMEMBER_NOTICE = `Remember browser access for future interactive Pi sessions? This saves enabled:true in your global browser/config.json. Future TUI/RPC sessions and reloads will register the pinned MCP server without another Pi confirmation, making browser tools available to those sessions. Print/JSON sessions do not auto-start. Chrome may still ask permission on each new debugging connection. /browser disable stops access in this session and revokes future automatic access. Other running Pi sessions must be disconnected separately. ${CONNECTION_NOTICE}`;

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserLifecycleError("Browser operation cancelled by lifecycle change.");
}

function safeError(error: unknown): string {
  return error instanceof BrowserLifecycleError ? error.message : "Browser lifecycle operation failed; inspect native /mcp. No browser identity was verified.";
}

export function registerBrowser(pi: ExtensionAPI, getAgentDir: () => string): void {
  const supported = typeof pi.registerMcpServer === "function" && typeof pi.unregisterMcpServer === "function" && typeof pi.getMcpServers === "function";
  const browser = new BrowserController({
    register: (name, config) => pi.registerMcpServer(name, config),
    unregister: (name) => pi.unregisterMcpServer(name),
    tools: () => pi.getAllTools(),
    servers: () => pi.getMcpServers(),
  }, (cwd) => auditMcpConfigs(getAgentDir(), cwd), process.platform);
  const preferences = () => new BrowserPreferences(getAgentDir());
  let operation = { abort: new AbortController(), busy: false };
  let automaticRegistration = "not_attempted";

  async function status() {
    const current = { ...browser.status(), nativeLifecycleSupported: supported, automaticRegistration };
    try {
      const store = preferences();
      const saved = await store.read();
      return { ...current, rememberedAccess: saved.enabled ? "enabled" : saved.exists ? "disabled" : "unconfigured", preferencesPath: store.path };
    } catch (error) {
      return { ...current, rememberedAccess: "invalid", preferenceError: safeError(error) };
    }
  }

  pi.registerTool({
    name: "browser_status",
    label: "Browser status",
    description: "Read browser registration and remembered-access state without connecting or reading tabs. Does not verify Chrome attachment/account identity. Use browser-assist; user can enable remembered access once with /browser enable or revoke it with /browser disable.",
    parameters: Type.Object({}),
    exposure: "codemode",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute() {
      const current = await status();
      return { content: [{ type: "text", text: JSON.stringify(current) }], details: current };
    },
  });

  pi.registerCommand("browser", {
    description: "Default Chrome assistance: setup, enable, disable, status",
    getArgumentCompletions(prefix) {
      return ["setup", "enable", "disable", "status"]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "status") { ctx.ui.notify(JSON.stringify(await status(), null, 2), "info"); return; }
      if (action === "setup") { pi.sendUserMessage(SETUP_PROMPT, { deliverAs: "followUp" }); return; }
      if (action === "connect" || action === "disconnect") {
        ctx.ui.notify("That browser command was removed. Use /browser enable for remembered access or /browser disable to stop current and future access. No changes made.", "warning"); return;
      }
      if (!["enable", "disable"].includes(action)) {
        ctx.ui.notify("Usage: /browser setup|enable|disable|status", "warning"); return;
      }
      if (!supported && action !== "disable") {
        ctx.ui.notify("This Pi host lacks native MCP registration/removal. Update Pi; no browser server started.", "error"); return;
      }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish before changing browser access.", "warning"); return; }
      const current = operation;
      if (current.busy) { ctx.ui.notify("A browser lifecycle operation is already pending; finish or cancel it first.", "warning"); return; }
      current.busy = true;
      let failurePrefix = "";
      try {
        active(current.abort.signal);
        if (action === "disable") {
          browser.disconnect();
          automaticRegistration = "stopped";
          failurePrefix = "Current session registration removed. ";
          const store = preferences();
          const saved = await store.read();
          active(current.abort.signal);
          const result = await store.setEnabled(saved, false, current.abort.signal);
          active(current.abort.signal);
          automaticRegistration = "disabled";
          ctx.ui.notify(`Remembered access disabled; current registration removed. Other Pi sessions, browser connections and Chrome debugging are unchanged.${result.backup ? ` Private backup: ${result.backup}` : ""}`, "info");
          return;
        }
        if (!ctx.hasUI) throw new BrowserLifecycleError("Browser enable requires interactive confirmation in Pi TUI or a supported RPC client.");
        const store = preferences();
        const saved = await store.read();
        active(current.abort.signal);
        await browser.auditConfiguration(ctx.cwd);
        active(current.abort.signal);
        if (!saved.enabled) {
          if ((await ctx.ui.confirm("Remember default Chrome access", REMEMBER_NOTICE, { signal: current.abort.signal })) !== true) throw new BrowserLifecycleError("Remembered browser access cancelled; preferences unchanged.");
          active(current.abort.signal);
          await browser.auditConfiguration(ctx.cwd);
          active(current.abort.signal);
          const result = await store.setEnabled(saved, true, current.abort.signal);
          failurePrefix = "Remembered opt-in was saved, but current registration failed. ";
          active(current.abort.signal);
          if (result.backup) ctx.ui.notify(`Previous browser preferences backed up privately: ${result.backup}`, "info");
        } else {
          failurePrefix = "Remembered opt-in was already enabled, but current registration failed. ";
        }
        if (!browser.hasRegistration()) {
          await browser.connect(ctx.cwd, async () => {
            const latest = await store.read();
            active(current.abort.signal);
            if (!latest.enabled) throw new BrowserLifecycleError("Remembered access was disabled during activation; no server registered.");
            return true;
          });
        }
        active(current.abort.signal);
        automaticRegistration = "registered";
        ctx.ui.notify(`Remembered access enabled in ${store.path}. Tools are registered for this session and future interactive sessions; Chrome still controls debugging approval. Use /browser disable to revoke remembered access.`, "info");
      } catch (error) {
        if (!current.abort.signal.aborted) ctx.ui.notify(failurePrefix + safeError(error), "error");
      } finally { current.busy = false; }
    },
  });

  async function autoRegister(ctx: ExtensionContext): Promise<void> {
    const current = operation;
    if (!supported) { automaticRegistration = "unsupported"; return; }
    if (!ctx.hasUI) { automaticRegistration = "interactive_required"; return; }
    current.busy = true;
    try {
      const store = preferences();
      const saved = await store.read();
      active(current.abort.signal);
      if (!saved.enabled) { automaticRegistration = "not_enabled"; return; }
      automaticRegistration = "starting";
      await browser.connect(ctx.cwd, async () => {
        const latest = await store.read();
        active(current.abort.signal);
        if (!latest.enabled) throw new BrowserLifecycleError("Remembered browser access was disabled during startup; no server registered.");
        return true;
      });
      active(current.abort.signal);
      automaticRegistration = "registered";
    } catch (error) {
      if (!current.abort.signal.aborted) {
        automaticRegistration = "blocked";
        ctx.ui.notify(`Remembered browser startup blocked: ${safeError(error)} Use /browser status; no automatic fallback.`, "warning");
      }
    } finally { current.busy = false; }
  }

  // Factories remain inert. Re-read the user's opt-in on each session, never from project settings.
  pi.on("session_start", async (_event, ctx) => {
    operation.abort.abort();
    browser.disconnect();
    operation = { abort: new AbortController(), busy: false };
    automaticRegistration = "not_attempted";
    await autoRegister(ctx);
  });
  pi.on("session_shutdown", () => { operation.abort.abort(); browser.disconnect(); });
}
