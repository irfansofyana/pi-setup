import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export interface DialogHost {
  requestRender(force?: boolean): void;
  terminal?: { rows: number };
}
export interface DialogEditorHost extends DialogHost {
  terminal: { rows: number };
}
export interface DialogRow {
  id: string;
  label: string;
  /** Trusted formatter receives sanitized text; generated ANSI styling is kept when clipping. */
  renderLabel?: (label: string, theme: Theme) => string;
  value?: string;
  valueColor?: Parameters<Theme["fg"]>[0];
  help?: string;
}
export const DIALOG_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "90%",
    maxHeight: "90%",
    margin: 1,
  },
} as const;

export function dialogText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Match Pi's overlay height calculation; maxHeight alone would clip the bottom border. */
export function dialogHeight(host: DialogHost): number {
  const rows = host.terminal?.rows ?? 24;
  return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9)));
}

export function frameDialog(
  theme: Theme,
  width: number,
  height: number,
  title: string,
  body: string[],
  footer: string,
): string[] {
  if (width <= 0 || height <= 0) return [];
  const fit = (text: string, columns: number) => {
    const clipped = truncateToWidth(text, Math.max(0, columns), "", true);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  if (width < 4 || height < 4)
    return [fit(theme.fg("muted", dialogText(title)), width)];
  const inner = width - 2;
  const line = (text: string) =>
    theme.fg("border", "│") + fit(text, inner) + theme.fg("border", "│");
  const heading = truncateToWidth(` ${dialogText(title)} `, inner, "");
  const top = theme.fg(
    "border",
    "╭" +
      heading +
      "─".repeat(Math.max(0, inner - visibleWidth(heading))) +
      "╮",
  );
  // Pad to the full frame so centered overlays keep the same bounds between views.
  const budget = height - 4;
  const padded = body.slice(0, budget);
  while (padded.length < budget) padded.push("");
  const content = padded.map(line);
  return [
    top,
    ...content,
    theme.fg("border", "├" + "─".repeat(inner) + "┤"),
    line(theme.fg("dim", dialogText(footer))),
    theme.fg("border", "╰" + "─".repeat(inner) + "╯"),
  ];
}

/** A multiline editor inside the same bounded shell as the surrounding form. */
export class DialogEditor {
  private editor: Editor;
  private initialText: string;
  constructor(
    private host: DialogEditorHost,
    private theme: Theme,
    readonly title: string,
    readonly prefill: string,
    private done: (value: string | undefined) => void,
  ) {
    this.editor = new Editor(
      host as ConstructorParameters<typeof Editor>[0],
      {
        borderColor: (text) => theme.fg("border", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      },
      { paddingX: 0 },
    );
    this.editor.setText(
      stripTerminalSequences(prefill)
        .replace(/\r\n?/g, "\n")
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
    );
    this.initialText = this.editor.getText();
    this.editor.disableSubmit = true;
  }
  getEditor(): Editor {
    return this.editor;
  }
  get focused(): boolean {
    return this.editor.focused;
  }
  set focused(value: boolean) {
    this.editor.focused = value;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.done(undefined);
    if (matchesKey(data, Key.ctrl("s"))) {
      const value = this.editor.getText();
      return this.done(value === this.initialText ? this.prefill : value);
    }
    this.editor.handleInput(data);
    this.host.requestRender();
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    const height = dialogHeight(this.host);
    const rows = this.editor.render(Math.max(1, width - 4)).slice(1, -1);
    const budget = Math.max(0, height - 4);
    const cursor = rows.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = cursor >= budget ? cursor - budget + 1 : 0;
    return frameDialog(
      this.theme,
      width,
      height,
      this.title,
      rows.slice(start, start + budget).map((line) => ` ${line}`),
      "Enter newline · Ctrl+S apply · Esc cancel",
    );
  }
}

export function dialogEditor(
  ctx: ExtensionContext,
  title: string,
  prefill: string,
): Promise<string | undefined> {
  return ctx.ui.custom(
    (host, theme, _keys, done) =>
      new DialogEditor(host, theme, title, prefill, done),
    DIALOG_OPTIONS,
  );
}

/** Bounded, two-column menu shared by settings and agent definitions. */
export class DialogMenu {
  private selected = 0;
  private viewport = 1;
  constructor(
    private host: DialogHost,
    private theme: Theme,
    readonly title: string,
    readonly rows: DialogRow[],
    private done: (id: string | undefined) => void,
    selectedId?: string,
    readonly footer = "↑↓ navigate · Enter select · Esc close",
    private saveId?: string,
  ) {
    const index = rows.findIndex((row) => row.id === selectedId);
    if (index >= 0) this.selected = index;
  }
  getSelectedId(): string | undefined {
    return this.rows[this.selected]?.id;
  }
  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (keys.matches(data, "tui.select.confirm"))
      return this.done(this.getSelectedId());
    if (this.saveId && matchesKey(data, Key.ctrl("s")))
      return this.done(this.saveId);
    let offset = 0;
    if (keys.matches(data, "tui.select.up")) offset = -1;
    else if (keys.matches(data, "tui.select.down") || matchesKey(data, Key.tab))
      offset = 1;
    else if (matchesKey(data, Key.pageUp)) offset = -this.viewport;
    else if (matchesKey(data, Key.pageDown)) offset = this.viewport;
    else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end))
      this.selected = Math.max(0, this.rows.length - 1);
    this.selected = Math.max(
      0,
      Math.min(this.rows.length - 1, this.selected + offset),
    );
    this.host.requestRender();
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = dialogHeight(this.host);
    const inner = Math.max(0, width - 4);
    const help = (this.rows[this.selected]?.help ?? "")
      .split(/\r\n?|\n/)
      .flatMap((line) => wrapTextWithAnsi(dialogText(line), Math.max(1, inner - 1)))
      .slice(0, Math.max(1, height - 7));
    this.viewport = Math.max(1, height - 6 - help.length);
    const start = Math.max(
      0,
      Math.min(
        this.selected - this.viewport + 1,
        this.rows.length - this.viewport,
      ),
    );
    const labelWidth = Math.min(28, Math.max(8, Math.floor(inner * 0.35)));
    const body = [
      this.theme.fg(
        "dim",
        ` ${this.rows.length ? this.selected + 1 : 0}/${this.rows.length} · Field / Value`,
      ),
      ...this.rows.slice(start, start + this.viewport).map((row, i) => {
        const selected = start + i === this.selected;
        const color = (text: string) => selected ? this.theme.fg("accent", text) : text;
        const plainLabel = dialogText(row.label);
        const label = truncateToWidth(
          row.renderLabel ? row.renderLabel(plainLabel, this.theme) : plainLabel,
          labelWidth,
          "",
          true,
        );
        const padding = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
        const value = dialogText(row.value ?? "");
        return color(`${selected ? "›" : " "} `)
          + (row.renderLabel ? label : color(label))
          + color(`${padding} │ `)
          + (row.valueColor ? this.theme.fg(row.valueColor, value) : color(value));
      }),
      "",
      ...help.map((line) => this.theme.fg("muted", ` ${line}`)),
    ];
    return frameDialog(
      this.theme,
      width,
      height,
      this.title,
      body,
      this.footer,
    );
  }
}

export function canOpenDialog(ctx: ExtensionContext): boolean {
  if (!ctx.hasUI) return false;
  if (ctx.mode && ctx.mode !== "tui") {
    ctx.ui.notify("Agents dialogs require interactive TUI mode.", "warning");
    return false;
  }
  return true;
}

export async function dialogMenu(
  ctx: ExtensionContext,
  title: string,
  rows: DialogRow[],
  options: { selectedId?: string; footer?: string; saveId?: string } = {},
): Promise<string | undefined> {
  return ctx.ui.custom(
    (host, theme, _keys, done) =>
      new DialogMenu(
        host,
        theme,
        title,
        rows,
        done,
        options.selectedId,
        options.footer,
        options.saveId,
      ),
    DIALOG_OPTIONS,
  );
}

export async function dialogInput(
  ctx: ExtensionContext,
  title: string,
  initial: string,
  help: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((host, theme, _keys, done) => {
    const input = new Input();
    input.setValue(dialogText(initial));
    input.onSubmit = done;
    input.onEscape = () => done(undefined);
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      handleInput: (data: string) => {
        input.handleInput(data);
        host.requestRender();
      },
      invalidate: () => input.invalidate(),
      render: (width: number) =>
        frameDialog(
          theme,
          width,
          dialogHeight(host),
          title,
          [
            "",
            ...input.render(Math.max(1, width - 4)).map((line) => ` ${line}`),
            "",
            ...help
              .split(/\r\n?|\n/)
              .flatMap((line) => wrapTextWithAnsi(dialogText(line), Math.max(1, width - 5)))
              .map((line) => theme.fg("muted", ` ${line}`)),
          ],
          "Enter apply · Esc cancel",
        ),
    };
  }, DIALOG_OPTIONS);
}

type DialogView = Component & {
  dispose?(): void;
  focused?: boolean;
};

type DialogFactory<T> = (
  host: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (result: T) => void,
) => DialogView | Promise<DialogView>;

interface PendingView {
  generation: number;
  settled: boolean;
  resolve: (value: unknown) => void;
}

const dialogScopes = new WeakSet<ExtensionContext>();

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).then === "function"
  );
}

function safeDispose(component: DialogView | undefined): void {
  if (!component?.dispose) return;
  try {
    component.dispose();
  } catch {
    // A view that fails to dispose must not reject the session promise.
  }
}

/** One overlay for a multi-step dialog. Child views swap without closing it. */
export class DialogSession {
  private child: DialogView | undefined;
  private focusedState = false;
  private inputLocked = true;
  private closed = false;
  private disposed = false;
  private generation = 0;
  private pending: PendingView | undefined;
  private outerDone: ((result?: void) => void) | undefined;

  constructor(
    private host: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    done: (result?: void) => void,
  ) {
    this.outerDone = done;
  }

  /** Current or last held child. Tests drive the active editor through this. */
  getComponent(): DialogView | undefined {
    return this.child;
  }

  restoreFocus(): void {
    if (this.closed) return;
    // Non-overlay custom views restore Pi's normal editor when they finish.
    this.host.setFocus(this);
    this.host.requestRender();
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.forwardFocus();
  }

  /**
   * Mount an overlay factory into this session. The returned promise settles
   * from the per-view done callback and does not complete the outer overlay.
   */
  mount<T>(factory: DialogFactory<T>): Promise<T> {
    if (this.closed) return Promise.resolve(undefined as T);
    const generation = ++this.generation;
    this.inputLocked = true;
    this.resolvePending();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: T) => {
        if (settled) return;
        settled = true;
        if (this.pending?.generation === generation)
          this.pending.settled = true;
        resolve(value);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.inputLocked = true;
        if (this.pending?.generation === generation)
          this.pending.settled = true;
        reject(error);
      };
      this.pending = {
        generation,
        settled: false,
        resolve: (value) => resolveOnce(value as T),
      };

      const finish = (value: T) => {
        if (this.closed || generation !== this.generation) return;
        this.inputLocked = true;
        resolveOnce(value);
      };

      const adopt = (component: DialogView) => {
        try {
          this.install(generation, component);
        } catch (error) {
          rejectOnce(error);
        }
      };

      try {
        const produced = factory(this.host, this.theme, this.keys, finish);
        if (isPromise(produced)) {
          void produced.then(
            (component) => adopt(component),
            (error: unknown) => {
              if (settled || this.closed || generation !== this.generation)
                return;
              rejectOnce(error);
            },
          );
        } else {
          adopt(produced);
        }
      } catch (error) {
        // done() may already have resolved; don't reject a settled view or leave a throw unhandled.
        rejectOnce(error);
      }
    });
  }

  handleInput(data: string): void {
    if (this.closed || this.inputLocked) return;
    this.child?.handleInput?.(data);
  }

  invalidate(): void {
    this.child?.invalidate();
  }

  render(width: number): string[] {
    return this.child?.render(width) ?? [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.inputLocked = true;
    this.resolvePending();
    const child = this.child;
    this.child = undefined;
    safeDispose(child);
  }

  /** Complete the outer overlay once. Safe to call after the host already closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inputLocked = true;
    this.resolvePending();
    const done = this.outerDone;
    this.outerDone = undefined;
    try {
      done?.();
    } finally {
      this.dispose();
    }
  }

  private install(generation: number, component: DialogView): void {
    if (this.closed || generation !== this.generation) {
      safeDispose(component);
      return;
    }
    this.replaceChild(component);
    this.inputLocked =
      this.pending?.generation === generation ? this.pending.settled : true;
    this.host.requestRender();
  }

  private replaceChild(next: DialogView): void {
    const previous = this.child;
    this.child = next;
    this.forwardFocus();
    if (!previous || previous === next) return;
    if ("focused" in previous) previous.focused = false;
    safeDispose(previous);
  }

  private forwardFocus(): void {
    const child = this.child;
    if (!child || !("focused" in child)) return;
    // Read the setter's latest value; the first view can mount before showOverlay focuses us.
    child.focused = this.focused;
  }

  private resolvePending(): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resolve(undefined);
  }
}

export function scopeDialogContext<T extends ExtensionContext>(
  ctx: T,
  session: DialogSession,
): T {
  const source = ctx.ui;
  const originalCustom = source.custom.bind(source);
  const ui = Object.create(source) as ExtensionUIContext;
  ui.custom = ((factory, options) => {
    if (options?.overlay) return session.mount(factory);
    return originalCustom(factory, options).finally(() =>
      session.restoreFocus(),
    );
  }) as ExtensionUIContext["custom"];
  // Pi exposes ctx.ui as a getter; assignment cannot shadow an inherited accessor.
  // Define an own property while keeping the remaining context getters live.
  return Object.create(ctx, {
    ui: { value: ui, writable: true, enumerable: true, configurable: true },
  }) as T;
}

/**
 * Run a dialog workflow inside one ctx.ui.custom overlay.
 * Nested calls on the scoped context reuse that overlay instead of opening another.
 */
export async function withDialogSession<T extends ExtensionContext>(
  ctx: T,
  run: (ctx: T) => Promise<void>,
): Promise<void> {
  if (dialogScopes.has(ctx)) {
    await run(ctx);
    return;
  }

  let failure: unknown;
  let failed = false;
  let session: DialogSession | undefined;
  try {
    await ctx.ui.custom<void>((host, theme, keys, done) => {
      session = new DialogSession(host, theme, keys, done);
      const scoped = scopeDialogContext(ctx, session);
      dialogScopes.add(scoped);
      // Pi mounts the returned component in a Promise continuation. Defer the
      // workflow so even an immediate return/throw closes after that mount.
      const task = Promise.resolve().then(() => run(scoped));
      void task.then(
        () => {
          try {
            session?.close();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        },
        (error: unknown) => {
          failed = true;
          failure = error;
          try {
            session?.close();
          } catch (closeError) {
            failure ??= closeError;
          }
        },
      );
      return session;
    }, DIALOG_OPTIONS);
  } catch (error) {
    try {
      session?.close();
    } catch {
      // The original custom rejection is the one that must propagate.
    }
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

