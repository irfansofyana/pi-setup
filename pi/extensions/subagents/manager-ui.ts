import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configureAgents } from "./upstream/src/ui/settings-ui.ts";
import { editAgentTypes } from "./upstream/src/ui/ui.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings, type ManagerSettings } from "./upstream/src/prefs/settings.ts";
import { reviewedTools, type createAgentRegistry } from "./registry.ts";
import { dialogMenu } from "./upstream/src/ui/dialog.ts";
import { offerAgentImport } from "./upstream/src/prefs/agent-import.ts";

/** Upstream dialogs with setup-owned ceilings checked BEFORE settings are saved. */
export function createManagerUI(options: {
  agentDir: string; cwd: string; store: ReturnType<typeof createAgentRegistry>;
  caps: { concurrency: number; threads: number; levels: number };
  apply(settings: ManagerSettings): void;
  reap?: { candidates(): string[]; close(paths: string[]): Promise<string[]> };
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  /** Private previews must never scan the real home profile. */
  importHomeDir?: string;
}) {
  const defaults: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS, widgetMode: "minimal", maxConcurrent: options.caps.concurrency,
    maxThreads: options.caps.threads, maxLevels: options.caps.levels };
  let settings: ManagerSettings;
  function validate(next: ManagerSettings) {
    for (const [key, ceiling] of [["maxConcurrent", options.caps.concurrency], ["maxThreads", options.caps.threads], ["maxLevels", options.caps.levels]] as const)
      if (!Number.isSafeInteger(next[key]) || next[key] < 1 || next[key] > ceiling) throw Error(`${key} exceeds deployment ceiling ${ceiling}`);
    if (next.toolFiltering !== "allowed") throw Error("This setup requires explicit Allowed tool filtering; canonical tool boundaries cannot expand");
  }
  function load() {
    const result = loadManagerSettings({ agentDir: options.agentDir, cwd: options.cwd, includeProject: options.store.canSaveProject(), defaults });
    if (result.diagnostics.length) throw Error(result.diagnostics.join("\n"));
    validate(result.settings); settings = result.settings;
  }
  load();
  const getAllTools = () => reviewedTools.map(name => ({ name, description: `Reviewed ${name} capability` }));
  return {
    get settings() { return { ...settings }; },
    async command(command: string, ctx: ExtensionCommandContext): Promise<boolean> {
      if (command === "import") {
        if (!options.pi) throw Error("Agent import requires a parent conversation");
        if (settings.subagentMode === "orchestration") {
          ctx.ui.notify("Switch to Opportunistic mode before importing; migration requires the parent's filesystem tools.", "warning");
          return true;
        }
        const constraints = `\n\n## Reviewed setup capabilities\nAvailable child tools: ${reviewedTools.join(", ")}. No shell, arbitrary MCP or ambient extension tools. Preserve researcher web-only, scout/reviewer read-only and network-free, and builder worktree-only writes. Keep all defaults fresh-context with bounded turns and no output transcripts. Do not overwrite bundled role policy or remove source definitions. Ask before changing installed/global configuration beyond the selected migration destinations.`;
        await offerAgentImport({ sendUserMessage: (text: string, delivery: any) => options.pi!.sendUserMessage(text + constraints, delivery) } as ExtensionAPI,
          ctx, { agentDir: options.agentDir, store: options.store, firstRun: false, homeDir: options.importHomeDir,
            ...(options.importHomeDir ? { extraAgentDirs: "" } : {}) });
        return true;
      }
      if(command==="reap"){
        const candidates=options.reap?.candidates()??[];
        if(!candidates.length){ctx.ui.notify("No completed agents eligible for reaping.","info");return true;}
        const choice=await dialogMenu(ctx,"Reap completed agents?",[
          {id:"confirm",label:"Confirm",help:`Forget ${candidates.length} completed sessions. They cannot be resumed. Unconsumed result evidence remains available separately.`},
          {id:"cancel",label:"Cancel"},
        ],{selectedId:"cancel"});
        if(choice==="confirm"){const closed=await options.reap!.close(candidates);ctx.ui.notify(`Reaped ${closed.length} completed agent(s).`,"info");}
        return true;
      }
      if (command === "reload") {
        options.store.reload(); load(); options.apply({ ...settings });
        ctx.ui.notify(options.store.diagnostics.length ? options.store.diagnostics.join("\n") : `Loaded ${options.store.list().length} agent types`, options.store.diagnostics.length ? "warning" : "info");
        return true;
      }
      if (command === "types") {
        await editAgentTypes(ctx, options.store, settings.nerdFontIcons, { getAllTools: getAllTools as any, toolFiltering: settings.toolFiltering });
        options.store.reload(); return true;
      }
      if (command === "settings") {
        await configureAgents(ctx, { store: options.store, agentDir: options.agentDir, settings: { ...settings }, defaults, validate,
          getAllTools: getAllTools as any, apply() { load(); options.apply({ ...settings }); } });
        return true;
      }
      return false;
    },
  };
}
