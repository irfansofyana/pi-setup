import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DIALOG_OPTIONS,
  dialogHeight,
  dialogText,
  frameDialog,
  type DialogHost,
} from "./dialog.ts";

export interface ImportPickerItem {
  id: string;
  label: string;
  detail: string;
}

const TITLE = "Import agents";
const DETAIL_LINE_CAP = 3;
// Critical controls first so a truncated footer still shows how to finish.
const FOOTER =
  "Space toggle · Enter import (empty skip) · Esc cancel · Ctrl+A all · ↑↓ navigate · PgUp/PgDn · Home/End";

/**
 * Agent labels and paths are untrusted. dialogText strips known sequences;
 * also drop Pi's cursor marker and any leftover ESC so a source file cannot
 * spoof the cursor or inject a title/color sequence.
 */
function agentText(text: string): string {
  return dialogText(text).split(CURSOR_MARKER).join("").replaceAll("\x1b", " ");
}

/**
 * truncateToWidth appends ESC [ 0 m when it clips. That reset is not a theme
 * color and must not become part of the wrapped agent text.
 */
function clipVisible(text: string, columns: number): string {
  if (columns <= 0 || !text) return "";
  if (visibleWidth(text) <= columns) return text;
  const clipped = truncateToWidth(text, columns, "").replaceAll("\x1b[0m", "");
  return clipped && text.startsWith(clipped) ? clipped : "";
}

/** Split sanitized text into frame-width lines without dropping a fitting prefix. */
function wrapText(text: string, columns: number): string[] {
  const clean = agentText(text);
  if (!clean || columns <= 0) return [];
  const lines: string[] = [];
  let rest = clean;
  while (rest.length > 0) {
    const chunk = clipVisible(rest, columns);
    if (!chunk) {
      rest = rest.slice(1);
      continue;
    }
    lines.push(chunk);
    if (chunk.length >= rest.length) break;
    rest = rest.slice(chunk.length);
  }
  return lines;
}

/**
 * Checkbox dialog for choosing external agents to migrate.
 * Selection only — the caller imports; this does not read or write agent files.
 */
export class ImportPicker {
  private cursor = 0;
  private viewport = 1;
  private readonly checked = new Set<string>();

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private readonly items: readonly ImportPickerItem[],
    private done: (ids: string[] | undefined) => void,
  ) {}

  /** Selected ids in source order. Empty until the user toggles a row. */
  getSelectedIds(): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of this.items) {
      if (!this.checked.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      ids.push(item.id);
    }
    return ids;
  }

  getCursorIndex(): number {
    return this.cursor;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      this.done(this.getSelectedIds());
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCursor();
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("a"))) {
      this.toggleAll();
      this.host.requestRender();
      return;
    }
    if (this.items.length === 0) return;
    if (keys.matches(data, "tui.select.up")) this.move(this.cursor - 1);
    else if (keys.matches(data, "tui.select.down")) this.move(this.cursor + 1);
    else if (keys.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp))
      this.move(this.cursor - this.viewport);
    else if (keys.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown))
      this.move(this.cursor + this.viewport);
    else if (matchesKey(data, Key.home)) this.move(0);
    else if (matchesKey(data, Key.end)) this.move(this.items.length - 1);
  }

  render(width: number): string[] {
    const height = dialogHeight(this.host);
    const budget = Math.max(0, height - 4);
    const columns = Math.max(1, width - 4);
    const current = this.items[this.cursor];
    const detail = current ? wrapText(current.detail, columns) : [];
    const headerCount = budget > 0 ? 1 : 0;
    // Keep the checkbox list usable: at most 3 detail lines, and never more than 1/3 of the body.
    let detailCount = Math.min(detail.length, DETAIL_LINE_CAP, Math.floor(budget / 3));
    if (this.items.length > 0)
      detailCount = Math.min(detailCount, Math.max(0, budget - headerCount - 1));
    const room = Math.max(0, budget - headerCount - detailCount);
    const gap = detailCount > 0 && room >= 3 ? 1 : 0;
    const listCount = Math.max(0, room - gap);
    this.viewport = Math.max(1, listCount);
    const start = this.windowStart(listCount);
    const shown = Math.min(listCount, Math.max(0, this.items.length - start));
    const body: string[] = [];
    if (headerCount) body.push(this.countLine(start, shown));
    if (this.items.length === 0) {
      if (listCount > 0) body.push(this.theme.fg("muted", " No external agents to import"));
    } else {
      const rows = this.items.slice(start, start + listCount);
      for (let offset = 0; offset < rows.length; offset++)
        body.push(this.row(rows[offset]!, start + offset === this.cursor));
    }
    if (gap) body.push("");
    for (const line of detail.slice(0, detailCount)) body.push(this.theme.fg("muted", ` ${line}`));
    return frameDialog(this.theme, width, height, TITLE, body, FOOTER);
  }

  private countLine(start: number, shown: number): string {
    const position = this.items.length ? this.cursor + 1 : 0;
    return this.theme.fg(
      "dim",
      ` ${this.scrollHint(start, shown)}${this.checked.size} selected · ${position}/${this.items.length}`,
    );
  }

  /** ▲/▼ counts when the checkbox list is scrolled. Omitted when every row fits. */
  private scrollHint(start: number, shown: number): string {
    if (this.items.length === 0) return "";
    const above = shown > 0 ? start : this.cursor;
    const below =
      shown > 0
        ? Math.max(0, this.items.length - (start + shown))
        : Math.max(0, this.items.length - this.cursor - 1);
    if (above <= 0 && below <= 0) return "";
    const parts: string[] = [];
    if (above > 0) parts.push(`▲${above}`);
    if (below > 0) parts.push(`▼${below}`);
    return `${parts.join(" ")} `;
  }

  private row(item: ImportPickerItem, active: boolean): string {
    const mark = this.checked.has(item.id) ? "x" : " ";
    const text = `${active ? "›" : " "}[${mark}] ${agentText(item.label)}`;
    return active ? this.theme.fg("accent", text) : text;
  }

  private windowStart(listCount: number): number {
    if (listCount <= 0 || this.items.length === 0) return 0;
    return Math.max(0, Math.min(this.cursor - listCount + 1, this.items.length - listCount));
  }

  private move(next: number): void {
    if (this.items.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, next));
    this.host.requestRender();
  }

  private toggleCursor(): void {
    const item = this.items[this.cursor];
    if (!item) return;
    if (this.checked.has(item.id)) this.checked.delete(item.id);
    else this.checked.add(item.id);
  }

  private toggleAll(): void {
    const all = this.items.length > 0 && this.items.every((item) => this.checked.has(item.id));
    if (all) {
      this.checked.clear();
      return;
    }
    for (const item of this.items) this.checked.add(item.id);
  }
}

/** Open the import checkbox dialog. Returns ids, [] to skip, or undefined if cancelled. */
export function selectImportAgents(
  ctx: ExtensionContext,
  items: readonly ImportPickerItem[],
): Promise<string[] | undefined> {
  return ctx.ui.custom(
    (host, theme, _keys, done) => new ImportPicker(host, theme, items, done),
    DIALOG_OPTIONS,
  );
}

