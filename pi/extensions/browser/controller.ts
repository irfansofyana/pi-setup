import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

/** Only errors authored here are safe to show without exposing transport/config details. */
export class BrowserLifecycleError extends Error {}

export const SERVER_NAME = "pi-setup-browser";
export const TOOL_PREFIX = "mcp__pi_setup_browser__";
export const MCP_VERSION = "1.11.0";
export const SETUP_PROMPT = "Use the bundled browser-setup skill. Audit prerequisites and existing browser MCP configuration read-only; present numbered proposals before any persistent changes. Do not connect to Chrome or install/run packages during this audit.";
export const CONNECTION_NOTICE = "Connect existing default Chrome profile? Chrome 144+ must already be running with remote debugging enabled at chrome://inspect/#remote-debugging. Chrome chooses the default profile and may expose every window in it. This starts pinned chrome-devtools-mcp via npx (first run may download it), with your OS permissions. Full standard tools are exposed, including tab closing, network inspection, performance and emulation. These tools can modify signed-in accounts or discard unsaved work. Browser content can reach the model provider and session logs. Approve Chrome's separate connection prompt when a browser tool first attaches. No profile copy or separate browser will be used. Continue only if permitted by your IT/data policies.";

export function serverConfig(platform: string): Extract<McpServerConfig, { command: string }> {
  const args = [
    "-y", `chrome-devtools-mcp@${MCP_VERSION}`, "--autoConnect",
    "--no-usage-statistics", "--no-performance-crux",
  ];
  return {
    command: platform === "win32" ? "cmd.exe" : "npx",
    args: platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args,
    exposure: "codemode",
    description: "Full standard Chrome DevTools tools on the existing default profile, including tab closing. Read browser-assist first; scope actions to the user's request. Not read-only or sandboxed.",
    timeout: 60,
  };
}

type ToolInfo = { name: string; exposure?: string };
export interface BrowserHost {
  register(name: string, config: McpServerConfig): void;
  unregister(name: string): void;
  tools(): ToolInfo[];
  servers(): Array<{ name: string; config: unknown }>;
}

/** Read connection definitions only. Never read Chrome profiles, credentials or page data. */
export async function auditMcpConfigs(agentDir: string, cwd: string): Promise<void> {
  const personal = new Map<string, unknown>();
  for (const [scope, file] of [
    ["personal", join(agentDir, "mcp.json")],
    ["project", join(cwd, ".pi", "mcp.json")],
  ]) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new BrowserLifecycleError(`Cannot audit ${scope} MCP configuration. Review it through native /mcp before connecting.`);
    }
    let config: unknown;
    try { config = JSON.parse(source); } catch {
      throw new BrowserLifecycleError(`Cannot parse ${scope} MCP configuration as JSON. Review it manually before connecting; no changes made.`);
    }
    if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
      throw new BrowserLifecycleError(`Invalid ${scope} MCP configuration. Review it through native /mcp before connecting.`);
    }
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      assertNoConflict(name, entry, `${scope} MCP configuration`);
      if (scope === "personal") {
        personal.set(name, entry);
      } else if (isRecord(entry) && entry.command === undefined && entry.url === undefined && entry.type === undefined && entry.enabled === true) {
        // Native Pi can re-enable a disabled personal connection with a partial project override.
        // Do not trust project disabling/replacement to hide a personal conflict: trust may differ.
        const base = personal.get(name);
        if (isRecord(base)) assertNoConflict(name, { ...base, enabled: true }, "potential effective personal/project MCP configuration");
      }
    }
  }
}

function assertNoConflict(name: string, entry: unknown, scope: string): void {
  if (name.replaceAll("-", "_") === SERVER_NAME.replaceAll("-", "_")) {
    throw new BrowserLifecycleError(`Reserved browser server name already exists in ${scope}. Preserve it; resolve the override explicitly before connecting.`);
  }
  if (!isRecord(entry) || entry.enabled === false) return;
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (command.includes("chrome-devtools-mcp") || args.some((arg) => typeof arg === "string" && arg.includes("chrome-devtools-mcp"))) {
    throw new BrowserLifecycleError(`Existing Chrome DevTools MCP entry found in ${scope}. Use native /mcp for it or approve a separate migration; this extension will not start a duplicate.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface BrowserStatus {
  state: "inactive" | "connection_pending" | "registered" | "tools_available";
  server: string;
  version: string;
  profile: "Chrome-selected default (not independently verified)";
  browserAttachment: "unverified";
  availableToolCount: number;
  note: string;
}

/** Registration state is deliberately separate from actual Chrome attachment/identity. */
export class BrowserController {
  private registered = false;
  private pending = false;
  private generation = 0;

  private readonly host: BrowserHost;
  private readonly audit: (cwd: string) => Promise<void>;
  private readonly platform: string;

  constructor(host: BrowserHost, audit: (cwd: string) => Promise<void>, platform: string) {
    this.host = host;
    this.audit = audit;
    this.platform = platform;
  }

  status(): BrowserStatus {
    const count = this.registered
      ? this.host.tools().filter((tool) => tool.name.startsWith(TOOL_PREFIX) && tool.exposure !== "hidden").length
      : 0;
    return {
      state: this.pending ? "connection_pending" : this.registered ? (count ? "tools_available" : "registered") : "inactive",
      server: SERVER_NAME,
      version: MCP_VERSION,
      profile: "Chrome-selected default (not independently verified)",
      browserAttachment: "unverified",
      availableToolCount: count,
      note: "Registration/tool discovery does not prove browser attachment, account identity or health. Inspect native /mcp for transport errors; verify a harmless existing tab with the user before reading private content. Other browser connections are outside this extension's control.",
    };
  }

  async auditConfiguration(cwd: string): Promise<void> {
    const generation = this.generation;
    await this.audit(cwd);
    if (generation !== this.generation) throw new BrowserLifecycleError("Browser connection cancelled by lifecycle change.");
    this.auditRegistrations();
  }

  hasRegistration(): boolean { return this.registered; }

  async connect(cwd: string, confirm: () => Promise<boolean>): Promise<void> {
    if (this.pending) throw new BrowserLifecycleError("A browser connection confirmation is already pending.");
    if (this.registered) throw new BrowserLifecycleError("Browser server already registered. Inspect /browser status and /mcp; use /browser disable then /browser enable only if a restart is intended.");
    this.pending = true;
    const generation = this.generation;
    try {
      await this.auditConfiguration(cwd);
      if (generation !== this.generation) throw new BrowserLifecycleError("Browser connection cancelled by lifecycle change.");
      if ((await confirm()) !== true) throw new BrowserLifecycleError("Browser connection cancelled; no server registered.");
      if (generation !== this.generation) throw new BrowserLifecycleError("Browser connection cancelled by lifecycle change.");
      // Recheck after the dialog: files may have changed while the user reviewed access.
      await this.auditConfiguration(cwd);
      if (generation !== this.generation) throw new BrowserLifecycleError("Browser connection cancelled by lifecycle change.");
      try { this.host.register(SERVER_NAME, serverConfig(this.platform)); } catch {
        throw new BrowserLifecycleError("Native MCP registration failed. Inspect /mcp; no browser identity was verified.");
      }
      this.registered = true;
    } finally {
      this.pending = false;
    }
  }

  private auditRegistrations(): void {
    for (const server of this.host.servers()) {
      if (this.registered && server.name === SERVER_NAME) continue;
      assertNoConflict(server.name, server.config, "extension MCP registry");
    }
  }

  disconnect(): void {
    this.generation++;
    // Native MCP unregisters only this extension's registration. Never send browser.close.
    if (this.registered) {
      try { this.host.unregister(SERVER_NAME); } catch {
        throw new BrowserLifecycleError("Native MCP removal failed. Inspect /mcp; do not assume browser access has ended.");
      }
      this.registered = false;
    }
  }
}
