import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const optionalSearchTools = ["fffind", "ffgrep", "fff-multi-grep"] as const;
const searchNames = new Set<string>(optionalSearchTools);

export function usesBundledResources(type: { source?: string; baseSource?: string; customization?: { kind: string } }): boolean {
  return type.source === "bundled" || (type.baseSource === "bundled" && type.customization?.kind === "override");
}

/** Only narrow fresh bundled initialization; never replay provider/execution failures. */
export function shouldUseBuiltinFallback(type: Parameters<typeof usesBundledResources>[0], optionalSelected: boolean, code: string, hasContext: boolean): boolean {
  return usesBundledResources(type) && optionalSelected && !hasContext && ["unsupported_resource", "initialization_failed"].includes(code);
}

/** Bundled conveniences are optional. Explicit user definitions remain exact. */
export function selectOptionalTools(names: readonly string[], source: string | undefined, available: readonly string[] = []): string[] {
  return names.filter(name => source !== "bundled" || !searchNames.has(name) || available.includes(name));
}

export function selectOptionalSkills(role: string, names: readonly string[], available: readonly string[] = []): string[] {
  return names.filter(name => role === "researcher" || available.includes(name));
}

/** Reuse only reviewed, read-only parent search tools, never ambient package loading. */
export function parentSearchTools(ctx: any): ToolDefinition[] {
  try {
    if (!ctx || typeof ctx.executeTool !== "function" || !Array.isArray(ctx.tools) || typeof ctx.cwd !== "string") return [];
    const cwd = ctx.cwd, executeTool = ctx.executeTool.bind(ctx);
    return ctx.tools.flatMap((tool: any): ToolDefinition[] => {
      try {
        if (!tool || !searchNames.has(tool.name) || typeof tool.description !== "string" || !tool.parameters || typeof tool.parameters !== "object" || tool.parameters.type !== "object") return [];
        const name = tool.name;
        return [{ name, label: tool.label ?? name, description: tool.description, parameters: tool.parameters,
          async execute(_id, params, signal, update, childContext) {
            // Parent search indexes belong to its cwd. Worktree children use their own built-ins.
            if (childContext.cwd !== cwd) throw Error("Parent search tool cwd mismatch");
            try {
              // Never inherit the completed parent launch call's abort signal.
              const outcome = await executeTool(name, params, { signal: signal ?? new AbortController().signal, onUpdate: update });
              if (outcome.isError) throw Error("Parent search tool failed");
              return outcome.result;
            } catch {
              // Child SDK turns this into a tool error; the built-in fallback remains callable.
              throw Error("Parent search tool failed; use built-in grep or find instead");
            }
          },
        }];
      } catch { return []; }
    });
  } catch { return []; }
}
