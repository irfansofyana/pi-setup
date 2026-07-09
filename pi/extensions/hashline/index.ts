import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const STATUS_ID = "hashline";

type JsonSchema = Record<string, unknown> & { optional?: true };
const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties).filter(([, schema]) => !schema.optional).map(([name]) => name);
    const cleanProperties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
      const { optional: _optional, ...clean } = schema;
      return [name, clean];
    }));
    return { type: "object", ...(required.length ? { required } : {}), properties: cleanProperties };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Number(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "number", ...options };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, optional: true };
  },
};

export type HashlineOperation =
  | { kind: "swap"; start: number; end: number; lines: string[] }
  | { kind: "delete"; start: number; end: number }
  | { kind: "insert"; position: "head" | "tail" | "pre" | "post"; line?: number; lines: string[] };

export interface HashlineSection {
  path: string;
  tag: string;
  operations: HashlineOperation[];
}

export interface HashlinePatch {
  sections: HashlineSection[];
}

export interface HashlineSnapshot {
  path: string;
  text: string;
  tag: string;
  seenLines: Set<number>;
  recordedAt: number;
}

export interface ApplyResult {
  text: string;
  tag: string;
  firstChangedLine?: number;
  warnings: string[];
}

/**
 * Short model-facing tag for the whole normalized file state.
 * This is intentionally UX-sized, not cryptographic identity. The snapshot
 * store keeps full text so callers can still validate/recover around collisions.
 */
export function computeFileTag(text: string): string {
  const normalized = normalizeHashText(text);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 4).toUpperCase();
}

function normalizeHashText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+(?=\n|$)/g, "");
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function lineNumbers(start: number, end: number): number[] {
  const out: number[] = [];
  for (let line = start; line <= end; line++) out.push(line);
  return out;
}

export class HashlineSession {
  #snapshots = new Map<string, HashlineSnapshot[]>();
  readonly maxVersionsPerPath: number;

  constructor(maxVersionsPerPath = 4) {
    this.maxVersionsPerPath = maxVersionsPerPath;
  }

  record(path: string, text: string, seenLines: Iterable<number> = []): string {
    const normalized = normalizeText(text);
    const tag = computeFileTag(normalized);
    const history = this.#snapshots.get(path) ?? [];
    const existing = history.find((snapshot) => snapshot.tag === tag && snapshot.text === normalized);
    if (existing) {
      for (const line of seenLines) existing.seenLines.add(line);
      existing.recordedAt = Date.now();
      this.#snapshots.set(path, [existing, ...history.filter((snapshot) => snapshot !== existing)]);
      return tag;
    }
    const snapshot: HashlineSnapshot = {
      path,
      text: normalized,
      tag,
      seenLines: new Set(seenLines),
      recordedAt: Date.now(),
    };
    this.#snapshots.set(path, [snapshot, ...history].slice(0, this.maxVersionsPerPath));
    return tag;
  }

  snapshot(path: string, tag: string): HashlineSnapshot | undefined {
    return this.#snapshots.get(path)?.find((snapshot) => snapshot.tag === tag);
  }

  head(path: string): HashlineSnapshot | undefined {
    return this.#snapshots.get(path)?.[0];
  }

  clear(): void {
    this.#snapshots.clear();
  }
}

export function formatHashlineHeader(path: string, tag: string): string {
  return `[${path}#${tag}]`;
}

export function formatHashlineRead(
  session: HashlineSession,
  path: string,
  text: string,
  options: { startLine?: number; endLine?: number } = {},
): string {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const startLine = clampLine(options.startLine ?? 1, lines.length);
  const endLine = clampLine(options.endLine ?? lines.length, lines.length);
  if (endLine < startLine) throw new Error(`endLine ${endLine} is before startLine ${startLine}`);
  const seen = lineNumbers(startLine, endLine);
  const tag = session.record(path, normalized, seen);
  const body = seen.map((line) => `${line}:${lines[line - 1] ?? ""}`);
  return [formatHashlineHeader(path, tag), ...body].join("\n");
}

function clampLine(value: number, lineCount: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.trunc(value), Math.max(1, lineCount)));
}

export function parseHashlineInput(input: string): HashlinePatch {
  const sections: HashlineSection[] = [];
  const rows = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  let current: HashlineSection | undefined;
  let pending: Extract<HashlineOperation, { lines: string[] }> | undefined;

  const flushPending = () => {
    pending = undefined;
  };

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const lineNumber = index + 1;
    const header = /^\[([^#\]]+)#([0-9A-Fa-f]{4})\]\s*$/.exec(row.trim());
    if (header) {
      flushPending();
      current = { path: header[1], tag: header[2].toUpperCase(), operations: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      if (row.trim() === "") continue;
      throw new Error(`line ${lineNumber}: hashline input must start with [path#TAG]`);
    }

    const trimmed = row.trimEnd();
    if (trimmed === "") continue;
    if (trimmed.startsWith("+")) {
      if (!pending) throw new Error(`line ${lineNumber}: payload line has no preceding SWAP or INS operation`);
      pending.lines.push(row.slice(1));
      continue;
    }

    flushPending();
    const swap = /^SWAP\s+(\d+)\s*(?:\.=?\.|\.=|-|…|\s+)\s*(\d+)\s*:\s*$/.exec(trimmed);
    if (swap) {
      const operation: HashlineOperation = { kind: "swap", start: Number(swap[1]), end: Number(swap[2]), lines: [] };
      validateRange(operation.start, operation.end, lineNumber);
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    const del = /^DEL\s+(\d+)(?:\s*(?:\.=?\.|\.=|-|…|\s+)\s*(\d+))?\s*$/.exec(trimmed);
    if (del) {
      const start = Number(del[1]);
      const end = Number(del[2] ?? del[1]);
      validateRange(start, end, lineNumber);
      current.operations.push({ kind: "delete", start, end });
      continue;
    }
    const insertEdge = /^INS\.(HEAD|TAIL)\s*:\s*$/.exec(trimmed);
    if (insertEdge) {
      const operation: HashlineOperation = { kind: "insert", position: insertEdge[1] === "HEAD" ? "head" : "tail", lines: [] };
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    const insertAnchor = /^INS\.(PRE|POST)\s+(\d+)\s*:\s*$/.exec(trimmed);
    if (insertAnchor) {
      const operation: HashlineOperation = {
        kind: "insert",
        position: insertAnchor[1] === "PRE" ? "pre" : "post",
        line: Number(insertAnchor[2]),
        lines: [],
      };
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    throw new Error(`line ${lineNumber}: unsupported hashline operation ${JSON.stringify(trimmed)}`);
  }

  for (const section of sections) {
    if (section.operations.length === 0) throw new Error(`section ${section.path} has no operations`);
    for (const operation of section.operations) {
      if ((operation.kind === "swap" || operation.kind === "insert") && operation.lines.length === 0) {
        throw new Error(`${operation.kind.toUpperCase()} operation in ${section.path} has no + payload lines`);
      }
    }
  }
  return { sections };
}

function validateRange(start: number, end: number, lineNumber: number): void {
  if (start < 1 || end < 1 || end < start) throw new Error(`line ${lineNumber}: invalid range ${start}.=${end}`);
}

export function applyHashlinePatch(session: HashlineSession, currentText: string, section: HashlineSection): ApplyResult {
  const normalized = normalizeText(currentText);
  const currentTag = computeFileTag(normalized);
  const snapshot = session.snapshot(section.path, section.tag);
  if (currentTag !== section.tag) {
    session.record(section.path, normalized);
    throw new Error(`stale tag ${section.tag} for ${section.path}; current tag ${currentTag}. Re-read the file and retry.`);
  }
  assertSeenAnchors(section, snapshot);

  const before = normalized.split("\n");
  const lines = [...before];
  const ordered = [...section.operations].sort((a, b) => maxAnchorLine(b) - maxAnchorLine(a));
  for (const operation of ordered) applyOperation(lines, operation);
  const text = lines.join("\n");
  const tag = session.record(section.path, text);
  return {
    text,
    tag,
    firstChangedLine: firstChangedLine(before, lines),
    warnings: [],
  };
}

function maxAnchorLine(operation: HashlineOperation): number {
  if (operation.kind === "insert") {
    if (operation.position === "tail") return Number.MAX_SAFE_INTEGER;
    if (operation.position === "head") return 0;
    return operation.line ?? 0;
  }
  return operation.end;
}

function applyOperation(lines: string[], operation: HashlineOperation): void {
  if (operation.kind === "swap") {
    assertLineExists(lines, operation.start);
    assertLineExists(lines, operation.end);
    lines.splice(operation.start - 1, operation.end - operation.start + 1, ...operation.lines);
    return;
  }
  if (operation.kind === "delete") {
    assertLineExists(lines, operation.start);
    assertLineExists(lines, operation.end);
    lines.splice(operation.start - 1, operation.end - operation.start + 1);
    return;
  }
  if (operation.position === "head") {
    lines.splice(0, 0, ...operation.lines);
    return;
  }
  if (operation.position === "tail") {
    lines.splice(lines.length, 0, ...operation.lines);
    return;
  }
  const line = operation.line ?? 0;
  assertLineExists(lines, line);
  lines.splice(operation.position === "pre" ? line - 1 : line, 0, ...operation.lines);
}

function assertLineExists(lines: string[], line: number): void {
  if (line < 1 || line > lines.length) throw new Error(`line ${line} does not exist; file has ${lines.length} lines`);
}

function assertSeenAnchors(section: HashlineSection, snapshot?: HashlineSnapshot): void {
  if (!snapshot || snapshot.seenLines.size === 0) return;
  for (const line of touchedAnchorLines(section)) {
    if (!snapshot.seenLines.has(line)) {
      throw new Error(`${section.path} line ${line} was not shown in the read that minted tag ${section.tag}; re-read that range before editing.`);
    }
  }
}

function touchedAnchorLines(section: HashlineSection): number[] {
  const lines: number[] = [];
  for (const operation of section.operations) {
    if (operation.kind === "insert") {
      if (operation.line !== undefined) lines.push(operation.line);
      continue;
    }
    for (let line = operation.start; line <= operation.end; line++) lines.push(line);
  }
  return [...new Set(lines)];
}

function firstChangedLine(before: string[], after: string[]): number | undefined {
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max; index++) {
    if (before[index] !== after[index]) return index + 1;
  }
  return undefined;
}

function relativePath(cwd: string, maybePath: string): string {
  if (!isAbsolute(maybePath)) return maybePath.replace(/\\/g, "/");
  const rel = relative(cwd, maybePath);
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : maybePath;
}

function absolutePath(cwd: string, maybePath: string): string {
  return isAbsolute(maybePath) ? maybePath : resolve(cwd, maybePath);
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
}

export default function hashlineExtension(pi: ExtensionAPI) {
  const session = new HashlineSession();
  let reads = 0;
  let edits = 0;

  const updateStatus = (ctx: any) => ctx?.ui?.setStatus?.(STATUS_ID, `hashline ${reads}r/${edits}e`);

  pi.registerTool({
    name: "hashline_read",
    label: "Hashline Read",
    description: "Read a file with a whole-file hashline tag and numbered lines for safer follow-up edits.",
    promptSnippet: "Use hashline_read before hashline_edit. Copy the [path#TAG] header and edit only numbered lines shown.",
    promptGuidelines: [
      "Use hashline_read before hashline_edit for files you plan to modify.",
      "Only edit lines that hashline_read displayed; re-read wider ranges before touching unseen lines.",
      "Use the exact [path#TAG] header from the latest read output.",
    ],
    parameters: Schema.Object({
      path: Schema.String({ description: "File path, relative to the current Pi project root when possible." }),
      startLine: Schema.Optional(Schema.Number({ description: "Optional first line to display, 1-indexed." })),
      endLine: Schema.Optional(Schema.Number({ description: "Optional last line to display, inclusive." })),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const abs = absolutePath(cwd, (params as { path: string }).path);
      const statText = readFileSync(abs, "utf8");
      if (Buffer.byteLength(statText, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw new Error(`File is larger than ${MAX_SNAPSHOT_BYTES} bytes; hashline snapshots are disabled for this file.`);
      }
      const rel = relativePath(cwd, abs);
      const text = formatHashlineRead(session, rel, statText, {
        startLine: (params as { startLine?: number }).startLine,
        endLine: (params as { endLine?: number }).endLine,
      });
      reads++;
      updateStatus(ctx);
      return { content: [{ type: "text", text }], details: { path: rel, tag: session.head(rel)?.tag } };
    },
  });

  pi.registerTool({
    name: "hashline_edit",
    label: "Hashline Edit",
    description: "Apply a hashline patch produced from hashline_read output.",
    promptSnippet: "Apply hashline edits with [path#TAG], SWAP/DEL/INS operations, and + payload lines.",
    promptGuidelines: [
      "Prefer one [path#TAG] section per file.",
      "Use SWAP N.=M: plus +payload lines to replace ranges, DEL N.=M to delete, INS.PRE/POST/HEAD/TAIL to insert.",
      "If hashline_edit reports a stale tag or unseen line, re-read the file/range before retrying.",
    ],
    parameters: Schema.Object({
      input: Schema.String({ description: "Hashline patch text." }),
    }) as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const patch = parseHashlineInput((params as { input: string }).input);
      const summaries: string[] = [];
      for (const section of patch.sections) {
        const abs = absolutePath(cwd, section.path);
        const current = readFileSync(abs, "utf8");
        const result = applyHashlinePatch(session, current, section);
        writeFileSync(abs, result.text, "utf8");
        edits++;
        summaries.push(`${formatHashlineHeader(section.path, result.tag)} changed at line ${result.firstChangedLine ?? "n/a"}`);
      }
      updateStatus(ctx);
      return { content: [{ type: "text", text: summaries.join("\n") }], details: { sections: patch.sections.length } };
    },
  });

  pi.registerCommand("hashline", {
    description: "Manage the local hashline extension snapshot cache",
    handler: async (args: string, ctx: any) => {
      const command = args.trim() || "status";
      if (command === "status") {
        notify(ctx, `hashline extension active · reads ${reads} · edits ${edits}`);
        updateStatus(ctx);
        return;
      }
      if (command === "clear") {
        session.clear();
        notify(ctx, "hashline snapshot cache cleared.");
        return;
      }
      notify(ctx, "Usage: /hashline status | clear", "warning");
    },
  });
}
