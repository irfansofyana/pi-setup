import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  setKeybindings,
  Key,
  matchesKey,
  type Keybinding,
} from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  canOpenDialog,
  DIALOG_OPTIONS,
  type DialogHost,
  DialogSession,
  scopeDialogContext,
  dialogMenu,
  dialogEditor,
  dialogHeight,
  dialogText,
  frameDialog,
} from "./dialog.ts";
import type { ThreadService } from "../types.ts";
import type { LoaderStyle } from "../prefs/settings.ts";
import { buildStatusTree, type StatusRow } from "./thread-tree.ts";
import {
  AGENT_PROGRESS_INTERVAL,
  agentProgressIcon,
  agentTypeBadge,
  agentTypeLabel,
  showThreads,
  threadMetrics,
} from "./ui.ts";
import { LiveAgentView, fillViewport, type AgentViewportState } from "./live-agent-view.ts";

export { buildStatusTree, type StatusRow };

const ROOT = "/root";
const INACTIVE_STATES = new Set(["paused", "stopped", "failed", "completed"]);
const TITLE = "Agents status";
const TREE_TITLE = "Agents tree";
const FOOTER =
  "Esc close · ↑↓ select · ←→ fold · PgUp/PgDn · Enter inspect · r refresh · Ctrl+C stop all";

function agentCount(threads: readonly { path?: string }[]): number {
  const paths = new Set<string>();
  for (const thread of threads) {
    if (thread?.path && thread.path !== ROOT) paths.add(thread.path);
  }
  return paths.size;
}

function lexicalParent(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : null;
}

function treeParent(rows: StatusRow[], index: number): StatusRow | undefined {
  const depth = rows[index]?.prefix.length ?? 0;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (rows[cursor]!.prefix.length < depth) return rows[cursor];
  }
  return undefined;
}

function firstChild(rows: StatusRow[], index: number): StatusRow | undefined {
  const next = rows[index + 1];
  return next && next.prefix.length > (rows[index]?.prefix.length ?? 0) ? next : undefined;
}

function label(row: StatusRow): string {
  if (!row.thread)
    return row.path === ROOT
      ? `${dialogText(row.path)}  main  running  main`
      : `${dialogText(row.path)}  missing parent`;
  return [row.path, row.thread.type, row.thread.state, row.thread.status]
    .map((part) => dialogText(part))
    .join("  ");
}

export interface AgentTreeState {
  selectedPath: string;
  collapsed: Set<string>;
}

export class StatusDialog {
  private state: AgentTreeState;
  private get selectedPath(): string {
    return this.state.selectedPath;
  }
  private set selectedPath(value: string) {
    this.state.selectedPath = value;
  }
  private get collapsed(): Set<string> {
    return this.state.collapsed;
  }
  private viewport = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshDelay = 0;
  private refreshing = false;

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private service: ThreadService,
    private done: (path: string | undefined) => void,
    selected?: string,
    private title = TITLE,
    private navigation?: {
      state: AgentTreeState;
      actions(path: string): void;
      fullscreen?: boolean;
    },
    private nerdFontIcons = false,
    private loaderStyle: LoaderStyle = "circle",
  ) {
    this.state = navigation?.state ?? { selectedPath: selected || ROOT, collapsed: new Set() };
  }

  invalidate(): void {}

  /** Poll retained status, accelerating the existing timer only for animated live agents. */
  startRefresh(): void {
    this.stopRefresh();
    this.refreshing = true;
    this.syncRefresh();
  }

  /** Stop the refresh. Safe to call more than once, including from dispose(). */
  dispose(): void {
    this.refreshing = false;
    this.stopRefresh();
  }

  private syncRefresh(): void {
    if (!this.refreshing) return;
    const delay =
      this.nerdFontIcons &&
      this.service
        .list()
        .some(
          (thread) =>
            thread.path !== ROOT && (thread.state === "starting" || thread.state === "running"),
        )
        ? AGENT_PROGRESS_INTERVAL
        : 1000;
    if (this.timer !== undefined && this.refreshDelay === delay) return;
    this.stopRefresh();
    this.refreshDelay = delay;
    this.timer = setInterval(() => {
      this.syncRefresh();
      this.host.requestRender();
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private stopRefresh(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.refreshDelay = 0;
  }

  /** Stop every live agent. Stopping a subtree covers its descendants, so only top-most live paths are sent. */
  private stopAll(): void {
    const live = this.service
      .list()
      .filter(
        (thread) =>
          thread.path !== ROOT && (thread.state === "starting" || thread.state === "running"),
      )
      .map((thread) => thread.path);
    const tops = live.filter((path) => !live.some((other) => path.startsWith(`${other}/`)));
    for (const path of tops) {
      void this.service
        .stop(path)
        .catch(() => {})
        .finally(() => this.host.requestRender());
    }
    this.host.requestRender();
  }

  private rows(): StatusRow[] {
    return buildStatusTree(this.service.list(), this.collapsed);
  }

  private locate(rows: StatusRow[]): number {
    const exact = rows.findIndex((row) => row.path === this.selectedPath);
    if (exact >= 0) return exact;
    let parent = lexicalParent(this.selectedPath);
    while (parent) {
      const index = rows.findIndex((row) => row.path === parent);
      if (index >= 0) return index;
      parent = lexicalParent(parent);
    }
    const root = rows.findIndex((row) => row.path === ROOT);
    return root >= 0 ? root : 0;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, Key.ctrl("c"))) {
      this.stopAll();
      return;
    }
    if (keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    const rows = this.rows();
    const index = this.locate(rows);
    const row = rows[index];
    if (row) this.selectedPath = row.path;
    if (keys.matches(data, "tui.select.confirm")) {
      if (this.navigation && row?.path === ROOT) this.done(undefined);
      else if (row?.thread && row.path !== ROOT) this.done(row.path);
      return;
    }
    if (data === "i" && this.navigation) {
      if (row?.thread && row.path !== ROOT) this.navigation.actions(row.path);
      return;
    }
    if (matchesKey(data, Key.ctrl("q")) && this.navigation) {
      this.done(undefined);
      return;
    }
    if (data === "r") {
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (row?.hasChildren && !this.collapsed.has(row.path)) this.collapsed.add(row.path);
      else if (row) {
        const parent = treeParent(rows, index);
        if (parent) this.selectedPath = parent.path;
      }
    } else if (matchesKey(data, Key.right)) {
      if (row?.hasChildren && this.collapsed.has(row.path)) this.collapsed.delete(row.path);
      else {
        const child = row?.hasChildren ? firstChild(rows, index) : undefined;
        if (child) this.selectedPath = child.path;
      }
    } else {
      let next = index;
      if (keys.matches(data, "tui.select.up")) next -= 1;
      else if (keys.matches(data, "tui.select.down")) next += 1;
      else if (matchesKey(data, Key.pageUp)) next -= this.viewport;
      else if (matchesKey(data, Key.pageDown)) next += this.viewport;
      else if (matchesKey(data, Key.home)) next = 0;
      else if (matchesKey(data, Key.end)) next = Math.max(0, rows.length - 1);
      else return;
      this.selectedPath =
        rows[Math.max(0, Math.min(rows.length - 1, next))]?.path ?? this.selectedPath;
    }
    this.host.requestRender();
  }

  private line(row: StatusRow, selected: boolean, width: number): string[] {
    const marker = row.hasChildren ? (this.collapsed.has(row.path) ? "▸ " : "▾ ") : "";
    const head = ` ${row.prefix}${selected ? "›" : " "} ${marker}`;
    const thread = row.thread;
    if (!thread) {
      const text = `${head}${label(row)}`;
      return [selected ? this.theme.fg("accent", text) : text, ""];
    }
    const inactive = INACTIVE_STATES.has(thread.state);
    const base = thread.state === "completed" ? "dim" : "muted";
    const hint =
      thread.state === "completed" ? "success" : thread.state === "failed" ? "error" : base;
    const progress = agentProgressIcon(
      thread,
      this.nerdFontIcons,
      Date.now(),
      true,
      this.loaderStyle,
    );
    const badge = inactive
      ? this.theme.fg(base, agentTypeLabel(thread.type, thread.icon, this.nerdFontIcons, progress))
      : agentTypeBadge(
          thread.type,
          thread.color,
          this.theme,
          thread.icon,
          this.nerdFontIcons,
          progress,
        );
    const identity = [
      thread.path,
      `${thread.model ?? "model pending"}${thread.thinkingLevel ? `:${thread.thinkingLevel}` : ""}`,
    ]
      .map((part) => dialogText(part))
      .join("  ");
    const identityLine = [
      selected ? this.theme.fg("accent", head) : head,
      badge,
      this.theme.fg(inactive ? base : selected ? "accent" : "text", `  ${identity}  `),
      this.theme.fg(inactive ? hint : "muted", dialogText(thread.state)),
    ].join("");
    // Continue the tree's vertical guides without repeating the branch or selection marker.
    const stem = row.prefix.replace("├ ", "│ ").replace("└ ", "  ");
    const activity = ` ${stem}  ${dialogText(thread.status || thread.task)}`;
    const metrics = this.theme.fg(base, threadMetrics(thread));
    const metricWidth = visibleWidth(metrics);
    const first =
      metricWidth >= width
        ? truncateToWidth(metrics, width, "")
        : (() => {
            const left = truncateToWidth(identityLine, width - metricWidth - 1);
            return left + " ".repeat(Math.max(1, width - visibleWidth(left) - metricWidth)) + metrics;
          })();
    const second = truncateToWidth(
      this.theme.fg(inactive ? base : selected ? "accent" : "muted", activity),
      width,
    );
    return [first, second];
  }

  private detail(row: StatusRow | undefined): string[] {
    if (!row?.thread) {
      return [
        ` ${row?.path === ROOT ? (agentCount(this.service.list()) ? "Main Pi session" : "Main Pi session — No agents yet") : "Missing parent"}`,
        "",
      ];
    }
    return [` task ${dialogText(row.thread.task)}`, ` ${threadMetrics(row.thread)}`];
  }

  render(width: number): string[] {
    this.syncRefresh();
    const rows = this.rows();
    const height = this.navigation?.fullscreen
      ? Math.max(1, this.host.terminal?.rows ?? 24)
      : dialogHeight(this.host);
    const index = this.locate(rows);
    if (rows[index]) this.selectedPath = rows[index].path;
    const budget = Math.max(0, height - 4);
    const detail = budget > 2 ? this.detail(rows[index]) : [];
    const treeCount = Math.max(0, Math.floor((budget - detail.length) / 2));
    this.viewport = Math.max(1, treeCount);
    const start = treeCount
      ? Math.max(0, Math.min(index - treeCount + 1, Math.max(0, rows.length - treeCount)))
      : 0;
    const body = [
      ...rows
        .slice(start, start + treeCount)
        .flatMap((row) => this.line(row, row.path === this.selectedPath, Math.max(0, width - 2))),
      ...detail,
    ];
    return frameDialog(
      this.theme,
      width,
      height,
      this.heading(rows, start, treeCount),
      body,
      this.navigation ? "Esc main · ↑↓ select · ←→ fold · i Actions · Ctrl+C stop all" : FOOTER,
    );
  }

  private heading(rows: StatusRow[], start: number, treeCount: number): string {
    if (this.title !== TREE_TITLE) return this.title;
    const agents = agentCount(this.service.list());
    const noun = agents === 1 ? "agent" : "agents";
    const total = rows.length;
    const shown = Math.max(0, Math.min(treeCount, total - start));
    if (shown <= 0) return `${TREE_TITLE}  ${agents} ${noun}`;
    return `${TREE_TITLE}  ${agents} ${noun}  ${start + 1}-${start + shown}/${total}`;
  }
}

async function showAgentDialog(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  options: {
    title?: string;
    selected?: string;
    inspect?: (path: string) => Promise<void>;
    nerdFontIcons?: boolean;
    loaderStyle?: LoaderStyle;
  } = {},
): Promise<void> {
  const open = options.inspect ?? ((path: string) => showThreads(ctx, service, path));
  let selected = options.selected;
  for (;;) {
    // Cleared on close and from dispose(): DialogSession host disposal can
    // leave this promise pending, so finally alone may not run immediately.
    let dialog: StatusDialog | undefined;
    try {
      const chosen = await ctx.ui.custom<string | undefined>((host, theme, _keys, done) => {
        dialog = new StatusDialog(
          host,
          theme,
          service,
          done,
          selected,
          options.title,
          undefined,
          options.nerdFontIcons,
          options.loaderStyle,
        );
        dialog.startRefresh();
        return dialog;
      }, DIALOG_OPTIONS);
      dialog?.dispose();
      dialog = undefined;
      if (!chosen) return;
      selected = chosen;
      await open(chosen);
    } finally {
      dialog?.dispose();
    }
  }
}

export async function showAgentStatus(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  inspect?: (path: string) => Promise<void>,
  nerdFontIcons = false,
  loaderStyle: LoaderStyle = "circle",
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await showAgentDialog(ctx, service, { inspect, nerdFontIcons, loaderStyle });
}

/** Root-owned navigation state. Opening and closing never changes the executing session. */
export class AgentNavigationController {
  private tree: AgentTreeState = { selectedPath: ROOT, collapsed: new Set() };
  private viewports = new Map<string, AgentViewportState>();
  private session: DialogSession | undefined;
  private opening: Promise<void> | undefined;
  private generation = 0;

  get isOpen(): boolean {
    return this.opening !== undefined;
  }

  close(): void {
    ++this.generation;
    this.session?.close();
    this.session = undefined;
  }

  open(
    ctx: ExtensionContext,
    service: ThreadService,
    selectedPath?: string,
    nerdFontIcons = false,
    loaderStyle: LoaderStyle = "circle",
  ): Promise<void> {
    if (this.opening) return this.opening;
    if (!canOpenDialog(ctx)) return Promise.resolve();
    if (selectedPath) this.tree.selectedPath = selectedPath;
    const generation = ++this.generation;
    let failure: unknown;
    let failed = false;
    let ownedSession: DialogSession | undefined;
    const task = ctx.ui.custom<void>(
      (host, theme, keys, done) => {
        const session = new DialogSession(host, theme, keys, done);
        ownedSession = session;
        if (generation !== this.generation) {
          void Promise.resolve().then(() => session.close());
          return session;
        }
        this.session = session;
        // The alt-screen renderer's listener runs before extension listeners. Temporarily
        // remove only its search action from the public keybinding lookup, before dispatch.
        const previousKeybindings = getKeybindings();
        const watchingKeybindings = new Proxy(previousKeybindings, {
          get(target, property) {
            if (property === "matches")
              return (data: string, action: Keybinding) =>
                action === "tui.altScreen.search" ? false : target.matches(data, action);
            // Preserve all other public manager methods and their original receiver.
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        setKeybindings(watchingKeybindings);
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          // Do not overwrite a newer keybinding owner installed by another extension.
          if (getKeybindings() === watchingKeybindings) setKeybindings(previousKeybindings);
          dispose();
        };
        // One fullscreen surface also covers shorter Actions dialogs without exposing main.
        const render = session.render.bind(session);
        session.render = (width) => fillViewport(render(width), width, host.terminal.rows);
        const scoped = scopeDialogContext(ctx, session);
        // Built-in UI dialogs otherwise stack independently. Mount these actions in our child slot.
        const ui = scoped.ui as ExtensionUIContext;
        ui.select = (title, options) =>
          dialogMenu(
            scoped,
            title,
            options.map((label) => ({ id: label, label })),
          );
        ui.confirm = async (title, message) =>
          (await dialogMenu(
            scoped,
            title,
            [
              { id: "Yes", label: "Yes", help: message },
              { id: "No", label: "No", help: message },
            ],
            { selectedId: "No" },
          )) === "Yes";
        ui.editor = (title, prefill) => dialogEditor(scoped, title, prefill ?? "");
        // Defer until Pi has installed/focused the overlay.
        void Promise.resolve()
          .then(async () => {
            while (generation === this.generation) {
              let treeDialog: StatusDialog | undefined;
              const chosen = await session.mount<
                { kind: "watch" | "actions"; path: string } | undefined
              >((tui, activeTheme, _keys, finish) => {
                treeDialog = new StatusDialog(
                  tui,
                  activeTheme,
                  service,
                  (path) => finish(path ? { kind: "watch", path } : undefined),
                  undefined,
                  TREE_TITLE,
                  {
                    state: this.tree,
                    fullscreen: true,
                    actions: (path) => finish({ kind: "actions", path }),
                  },
                  nerdFontIcons,
                  loaderStyle,
                );
                treeDialog.startRefresh();
                return treeDialog;
              });
              treeDialog?.dispose();
              if (!chosen || generation !== this.generation) break;
              if (chosen.kind === "actions") {
                await showThreads(scoped, service, chosen.path);
                continue;
              }
              let viewport = this.viewports.get(chosen.path);
              if (!viewport) {
                viewport = { scrollTop: 0, follow: true };
                this.viewports.set(chosen.path, viewport);
              }
              const result = await session.mount<"back" | "main">(
                (tui, activeTheme, _keys, finish) =>
                  new LiveAgentView(
                    tui,
                    activeTheme,
                    service,
                    chosen.path,
                    viewport!,
                    finish,
                    nerdFontIcons,
                    loaderStyle,
                  ),
              );
              if (result !== "back") break;
            }
          })
          .then(
            () => session.close(),
            (error: unknown) => {
              failed = true;
              failure = error;
              ctx.ui.notify(
                dialogText(error instanceof Error ? error.message : String(error)),
                "error",
              );
              session.close();
            },
          );
        return session;
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
      },
    );
    this.opening = task
      .then(() => {
        if (failed) throw failure;
      })
      .finally(() => {
        // Also clean up if the host rejects mounting after our factory returned.
        ownedSession?.dispose();
        if (this.opening === result) this.opening = undefined;
        if (generation === this.generation) this.session = undefined;
      });
    const result = this.opening;
    return result;
  }
}

const navigationByService = new WeakMap<ThreadService, AgentNavigationController>();

export async function showAgentTree(
  ctx: ExtensionContext,
  service: ThreadService,
  selectedPath?: string,
  nerdFontIcons = false,
  loaderStyle: LoaderStyle = "circle",
): Promise<void> {
  let navigation = navigationByService.get(service);
  if (!navigation) {
    navigation = new AgentNavigationController();
    navigationByService.set(service, navigation);
  }
  await navigation.open(ctx, service, selectedPath, nerdFontIcons, loaderStyle);
}

