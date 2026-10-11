import {
  ToolExecutionComponent,
  type ToolDefinition,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

/** Only trusted pi built-ins: observing a transcript must never execute extension renderers. */
type Renderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;
const renderers = new Map<string, Renderers>(
  [
    createBashToolDefinition(process.cwd()),
    createPowerShellToolDefinition(process.cwd()),
    createReadToolDefinition(process.cwd()),
    createEditToolDefinition(process.cwd()),
    createWriteToolDefinition(process.cwd()),
    createGrepToolDefinition(process.cwd()),
    createFindToolDefinition(process.cwd()),
    createLsToolDefinition(process.cwd()),
  ].map((tool) => [
    tool.name,
    { renderCall: tool.renderCall, renderResult: tool.renderResult } as Renderers,
  ]),
);

// Native edit call previews otherwise read today's file asynchronously. An observer must
// use the recorded result.diff, not inspect a possibly different worktree on every paint.
const edit = renderers.get("edit")!;
const editCall = edit.renderCall!;
edit.renderCall = (args, theme, context) =>
  editCall(args, theme, { ...context, argsComplete: false });

// Pi's generic fallback is unbounded. Retain the native tool box/title, but bound
// unknown-tool previews by visual rows (extension tools can return enormous single lines).
const generic: Renderers = {
  renderResult(result, options, theme) {
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const bounded = options.expanded ? output : output.slice(0, 32768);
    const component = new Text(theme.fg("toolOutput", bounded), 0, 0);
    return {
      invalidate() {
        component.invalidate();
      },
      render(width) {
        const rows = component.render(width);
        if (options.expanded || (rows.length <= 5 && bounded.length === output.length)) return rows;
        return [...rows.slice(0, 5), theme.fg("muted", "… more lines (Ctrl+O to expand)")];
      },
    };
  },
};
function safeText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Sanitize args, content AND details before trusted renderers interpolate them. */
function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): any {
  if (typeof value === "string") return safeText(value);
  if (!value || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) return "[Circular]";
  if (depth > 64) return "[Nested data omitted]";
  seen.add(value);
  const safe = Array.isArray(value)
    ? value.map((item) => sanitize(item, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          safeText(key),
          sanitize(item, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return safe;
}

export function renderTranscriptTool(
  name: string,
  id: string,
  args: unknown,
  result: unknown,
  isError: boolean,
  running: boolean,
  detail: "full" | "preview" | "compact",
  width: number,
): string[] {
  // The native shell renderer owns elapsed-time intervals after markExecutionStarted().
  // An observer has no execution lifecycle to dispose, so intentionally don't start that clock.
  const ui = { requestRender() {} } as TUI;
  const component = new ToolExecutionComponent(
    safeText(name),
    safeText(id),
    sanitize(args),
    { showImages: false },
    renderers.get(name) ?? generic,
    ui,
    process.cwd(),
  );
  const data =
    result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
  const content = data?.content ?? result;
  component.updateResult(
    {
      content: (Array.isArray(content) ? content : content === undefined ? [] : [content]).map(
        (block) => {
          // Never hand image payloads to pi (even showImages:false can trigger Kitty conversion).
          if (block && typeof block === "object" && (block as { type?: string }).type === "image")
            return { type: "text", text: "[Image — text-only observer]" };
          if (block && typeof block === "object" && (block as { type?: string }).type === "text")
            return {
              type: "text",
              text: safeText(String((block as { text?: unknown }).text ?? "")),
            };
          return {
            type: "text",
            text: safeText(
              typeof block === "string" ? block : (JSON.stringify(sanitize(block)) ?? ""),
            ),
          };
        },
      ),
      details: sanitize(data?.details),
      isError: isError || data?.isError === true,
    },
    running,
  );
  component.setExpanded(detail === "full");
  const lines = component.render(Math.max(3, width));
  if (detail === "compact")
    return lines.filter((line) => stripTerminalSequences(line).trim()).slice(0, 1);
  return lines;
}

