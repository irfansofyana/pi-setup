import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptSnapshot } from "./upstream/src/types.ts";

export type TaskMessage = { key: string; role: "You" | "Agent"; text: string; offset: number; omitted: boolean };
export type TaskLine = { key: string; text: string; tone: "text" | "accent" | "dim" };
const MESSAGE_LIMIT = 24, MESSAGE_CHARS = 12_000, TOTAL_CHARS = 48_000;

export function taskText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Only text blocks cross this boundary. Never retain the original snapshot or tool payloads. */
export function projectTaskMessages(snapshot: TranscriptSnapshot): TaskMessage[] {
  const entries = snapshot.messages.slice(-MESSAGE_LIMIT).map((message, index) => ({ message, index: Math.max(0, snapshot.messages.length - MESSAGE_LIMIT) + index }));
  if (snapshot.assistant && snapshot.assistant !== snapshot.messages.at(-1)) entries.push({ message: snapshot.assistant, index: snapshot.messages.length });
  const result: TaskMessage[] = [];
  let remaining = TOTAL_CHARS;
  for (const { message, index } of entries.reverse()) {
    if (result.length >= MESSAGE_LIMIT || remaining <= 0) break;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const value = message as unknown as Record<string, unknown>;
    const role = message.role === "user" ? "You" : "Agent";
    const key = `${snapshot.generation}:${role}:${typeof value.timestamp === "number" ? value.timestamp : "untimed"}:${index}`;
    if (role === "Agent" && (value.errorMessage || value.stopReason === "error")) {
      const text = "Provider error (details hidden)".slice(0, remaining);
      result.push({ key, role, text, offset: 0, omitted: false }); remaining -= text.length;
      continue;
    }
    const parts = typeof value.content === "string" ? [value.content] : Array.isArray(value.content)
      ? value.content.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string").map(block => block.text) : [];
    const total = parts.reduce((size, part) => size + part.length, Math.max(0, parts.length - 1));
    const cap = Math.min(MESSAGE_CHARS, remaining);
    let raw = "";
    for (let i = parts.length - 1; i >= 0 && raw.length < cap; i--) {
      const suffix = raw ? `\n${raw}` : "";
      const room = Math.max(0, cap - suffix.length);
      raw = (room ? parts[i].slice(-room) : "") + suffix;
      raw = raw.slice(-cap);
    }
    const text = taskText(raw);
    if (!text.trim()) continue;
    result.push({ key, role, text, offset: Math.max(0, total - raw.length), omitted: total > raw.length });
    remaining -= text.length;
  }
  return result.reverse();
}

/** Source offsets keep a scrolled viewport anchored when later text streams in. */
export function wrapTaskMessages(messages: readonly TaskMessage[], width: number): TaskLine[] {
  if (width <= 0) return [];
  const rows: TaskLine[] = [];
  // Clipping may add ANSI resets even to plain labels; sanitize every output path.
  const clip = (text: string) => taskText(truncateToWidth(taskText(text), width, ""));
  for (const message of messages) {
    if (rows.length) rows.push({ key: `${message.key}:separator`, text: "", tone: "dim" });
    rows.push({ key: `${message.key}:role`, text: clip(message.role), tone: "accent" });
    if (message.omitted) {
      for (const [index, chunk] of wrapTextWithAnsi("Earlier text omitted…", width).entries()) rows.push({ key: `${message.key}:omitted:${index}`, text: clip(chunk), tone: "dim" });
    }
    let offset = message.offset;
    for (const line of message.text.split("\n")) {
      const chunks = wrapTextWithAnsi(line, width);
      let cursor = 0;
      for (const wrapped of chunks) {
        const chunk = taskText(wrapped);
        // Pi may emit an empty/ANSI-only row before a grapheme wider than the viewport.
        if (!chunk && chunks.length > 1) continue;
        // Projection is plain text; recover offsets across whitespace trimmed by Pi.
        const start = Math.max(cursor, line.indexOf(chunk, cursor));
        rows.push({ key: `${message.key}:${offset + start}`, text: clip(chunk), tone: "text" });
        cursor = start + chunk.length;
      }
      offset += line.length + 1;
    }
  }
  return rows;
}
