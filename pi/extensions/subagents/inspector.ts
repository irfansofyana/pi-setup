import { stripVTControlCharacters } from "node:util";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

export const safeText = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export function appendInspector(previous: string, incoming: string): string {
  const bytes = Buffer.from(previous + safeText(incoming));
  return bytes.length > 65536 ? "[earlier activity truncated]\n" + bytes.subarray(bytes.length - 65480).toString("utf8") : bytes.toString("utf8");
}
/** Modal only: closing the view never closes the thread or steals editor arrows. */
export class Inspector {
  private offset = 0;
  private follow = true;
  private unsubscribe: () => void;
  private tui: any;
  private snapshot: () => string;
  private done: (value: undefined) => void;
  constructor(tui: any, snapshot: () => string, subscribe: (listener: () => void) => () => void, done: (value: undefined) => void) {
    this.tui=tui;this.snapshot=snapshot;this.done=done;
    this.unsubscribe = subscribe(() => tui.requestRender());
  }
  invalidate() {}
  dispose() { this.unsubscribe();this.unsubscribe=()=>{}; }
  handleInput(data: string) {
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.dispose(); this.done(undefined); return; }
    if (data === "f") this.follow = true;
    else if (data === "j" || matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) { this.follow = false; this.offset += 5; }
    else if (data === "k" || matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) { this.follow = false; this.offset = Math.max(0,this.offset-5); }
    this.tui.requestRender();
  }
  render(width: number) {
    const lines = new Text(safeText(this.snapshot()),0,0).render(width);
    const height = Math.max(4,Math.min(24,(this.tui.terminal?.rows ?? 24)-6));
    const last = Math.max(0,lines.length-height);
    this.offset = this.follow ? last : Math.min(this.offset,last);
    return [truncateToWidth("Live inspector | ↑↓/j/k scroll | f follow | q/esc close view (worker continues)",width),...lines.slice(this.offset,this.offset+height)];
  }
}
