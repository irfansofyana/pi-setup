import {
  CustomEditor,
  type CustomEditorOptions,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Key,
  matchesKey,
  type EditorTheme,
  type Keybinding,
  type TUI,
} from "@earendil-works/pi-tui";

export interface AgentNavigationEditorOptions {
  /** Must return the whole navigation interaction, so repeated Left cannot reopen it. */
  openTree(): void | Promise<void>;
  canOpen(): boolean;
  /** Session-local widget collapse; never saves the configured display mode. */
  collapseWidget?(): void | Promise<void>;
  canCollapse?(): boolean;
  /** Root ownership token; changing it invalidates queued transitions. */
  generation(): unknown;
  onError?(error: unknown): void;
  /**
   * Chronological user prompts for reload/new/resume/fork. Omit on startup:
   * Pi hydrates the installed editor after the startup session_start event.
   */
  initialHistory?: readonly string[];
}

/**
 * Physical arrow boundary adapter. It owns no session/history internals and never
 * changes the draft. Install once per root UI lifecycle, not for tree navigation.
 * Another custom editor occupies the same host slot; skip installation rather than stack.
 */
export class AgentNavigationEditor extends CustomEditor {
  private pending: "left" | "right" | undefined;
  private disposed = false;
  private dispatchDepth = 0;
  private inputEpoch = 0;
  private pastePending = false;
  private jumpPending = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private navigationKeys: KeybindingsManager,
    private navigation: AgentNavigationEditorOptions,
    options?: CustomEditorOptions,
  ) {
    super(tui, theme, navigationKeys, options);
    // SessionStartEvent.reason distinguishes startup (host hydrates AFTER
    // installation) from reload/replacement (explicit public hydration needed).
    // Never infer replay from prompt text: intentional repetitions are valid.
    for (const text of navigation.initialHistory ?? []) this.addToHistory(text);
  }

  /** Invalidates queued work without resetting a competing extension's editor. */
  dispose(): void {
    this.disposed = true;
    this.inputEpoch++;
  }

  private ordinaryArrow(data: string, direction: "left" | "right"): boolean {
    if (!matchesKey(data, direction === "left" ? Key.left : Key.right)) return false;
    const action = direction === "left" ? "tui.editor.cursorLeft" : "tui.editor.cursorRight";
    // Editor uses the global TUI bindings; CustomEditor uses the injected app
    // manager. Both must agree, and a conflicting remap wins conservatively.
    for (const keys of [this.navigationKeys, getKeybindings()]) {
      if (!keys.matches(data, action)) return false;
      for (const other of Object.keys(keys.getResolvedBindings())) {
        if (
          other !== action &&
          (other.startsWith("tui.editor.") ||
            other.startsWith("tui.input.") ||
            other.startsWith("tui.altScreen.") ||
            other.startsWith("app.")) &&
          keys.matches(data, other as Keybinding)
        )
          return false;
      }
    }
    return true;
  }

  override handleInput(data: string): void {
    const outer = this.dispatchDepth === 0;
    const direction = this.ordinaryArrow(data, "left") ? "left"
      : this.ordinaryArrow(data, "right") ? "right" : undefined;
    if (outer && (!direction || (this.pending && this.pending !== direction))) this.inputEpoch++;
    const previousPaste = this.pastePending;
    const wasPaste = previousPaste || data.includes("\x1b[200~");
    // Update before dispatch: Pi recursively sends a suffix after the end
    // marker through this.handleInput, and that suffix is no longer paste.
    if (data.includes("\x1b[200~")) this.pastePending = true;
    if (wasPaste && data.includes("\x1b[201~")) this.pastePending = false;
    const wasJump = this.jumpPending;
    const cursor = this.getCursor();
    const text = this.getText();
    const lines = text.split("\n");
    const atBoundary = direction === "left"
      ? cursor.line === 0 && cursor.col === 0
      : direction === "right" && cursor.line === lines.length - 1 &&
        cursor.col === lines.at(-1)!.length;
    const eligible =
      outer &&
      direction !== undefined &&
      this.focused &&
      !this.disposed &&
      !wasPaste &&
      !wasJump &&
      !this.isShowingAutocomplete() &&
      atBoundary;
    const generation = eligible ? this.navigation.generation() : undefined;
    let changed = false;
    let consumed = false;
    const originalChange = this.onChange;
    const originalShortcut = this.onExtensionShortcut;
    const observeChange = (value: string) => {
      changed = true;
      originalChange?.call(this, value);
    };
    const observeShortcut = (value: string) => {
      const handled = originalShortcut?.call(this, value) ?? false;
      consumed ||= handled && value === data;
      return handled;
    };
    this.onChange = observeChange;
    this.onExtensionShortcut = observeShortcut;
    this.dispatchDepth++;
    try {
      // Exactly one stock dispatch, preserving host-wired application controls.
      super.handleInput(data);
    } finally {
      this.dispatchDepth--;
      if (this.onChange === observeChange) this.onChange = originalChange;
      if (this.onExtensionShortcut === observeShortcut) this.onExtensionShortcut = originalShortcut;
      if (consumed) this.pastePending = previousPaste;
      if (!consumed) {
        // Track only public input; over-suppress when precedence is ambiguous.
        // Recursive paste suffix dispatch updates guards, but never opens UI.
        if (!wasPaste) {
          const keys = getKeybindings();
          const jump =
            keys.matches(data, "tui.editor.jumpForward") ||
            keys.matches(data, "tui.editor.jumpBackward");
          this.jumpPending = !wasJump && jump;
        }
      }
    }
    const after = this.getCursor();
    if (
      eligible &&
      !consumed &&
      !changed &&
      !this.isShowingAutocomplete() &&
      this.getText() === text &&
      after.line === cursor.line &&
      after.col === cursor.col
    ) {
      this.queueNavigation(text, cursor, generation, direction!);
    }
  }

  private queueNavigation(
    text: string,
    cursor: { line: number; col: number },
    generation: unknown,
    direction: "left" | "right",
  ): void {
    const allowed = () => direction === "left"
      ? this.navigation.canOpen()
      : !!this.navigation.collapseWidget && (this.navigation.canCollapse?.() ?? false);
    if (this.pending || !allowed()) return;
    this.pending = direction;
    const epoch = this.inputEpoch;
    queueMicrotask(() => {
      const after = this.getCursor();
      if (
        this.disposed ||
        !this.focused ||
        this.inputEpoch !== epoch ||
        this.navigation.generation() !== generation ||
        !allowed() ||
        this.isShowingAutocomplete() ||
        this.getText() !== text ||
        after.line !== cursor.line ||
        after.col !== cursor.col
      ) {
        this.pending = undefined;
        return;
      }
      try {
        // Call within the checked microtask: an extra Promise.then would leave
        // a gap in which root ownership could change after validation.
        void Promise.resolve(direction === "left"
          ? this.navigation.openTree() : this.navigation.collapseWidget!())
          .catch((error: unknown) => this.navigation.onError?.(error))
          .finally(() => {
            this.pending = undefined;
          });
      } catch (error) {
        this.pending = undefined;
        this.navigation.onError?.(error);
      }
    });
  }
}

