import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const HASHLINE_TAG_HEX_LENGTH = 12;
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
  | { kind: "insert"; position: "head" | "tail" | "pre" | "post"; line?: number; lines: string[] }
  | { kind: "block_swap"; line: number; lines: string[] }
  | { kind: "block_delete"; line: number }
  | { kind: "block_insert_post"; line: number; lines: string[] };

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

interface TextFormat {
  bom: string;
  lineEnding: "\n" | "\r\n";
}

export interface ApplyResult {
  /** LF-normalized, BOM-stripped post-edit text. */
  text: string;
  /** Text ready to write back to disk, preserving the input BOM and dominant EOL. */
  persisted: string;
  tag: string;
  firstChangedLine?: number;
  warnings: string[];
}

export interface PreparedHashlineWrite extends ApplyResult {
  path: string;
}

export interface HashlineFileIO {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

/**
 * Short model-facing tag for the whole normalized file state.
 * This remains UX-sized, but uses enough bits that accidental collisions are
 * impractical for local editing. The snapshot store still validates full text.
 */
export function computeFileTag(text: string): string {
  const normalized = normalizeHashText(text);
  return createHash("sha256").update(normalized).digest("hex").slice(0, HASHLINE_TAG_HEX_LENGTH).toUpperCase();
}

function normalizeHashText(text: string): string {
  return normalizeTextWithFormat(text).text.replace(/[ \t]+(?=\n|$)/g, "");
}

function normalizeText(text: string): string {
  return normalizeTextWithFormat(text).text;
}

function normalizeTextWithFormat(text: string): { text: string; format: TextFormat } {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? text.slice(1) : text;
  const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  return {
    text: withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    format: { bom, lineEnding },
  };
}

function restoreTextFormat(text: string, format: TextFormat): string {
  const withLineEndings = format.lineEnding === "\n" ? text : text.replace(/\n/g, "\r\n");
  return `${format.bom}${withLineEndings}`;
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
    const header = /^\[([^#\]]+)#([0-9A-Fa-f]{12})\]\s*$/.exec(row.trim());
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
    const blockSwap = /^SWAP\.BLK\s+(\d+)\s*:\s*$/.exec(trimmed);
    if (blockSwap) {
      const operation: HashlineOperation = { kind: "block_swap", line: Number(blockSwap[1]), lines: [] };
      validateRange(operation.line, operation.line, lineNumber);
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    const blockDelete = /^DEL\.BLK\s+(\d+)\s*$/.exec(trimmed);
    if (blockDelete) {
      const line = Number(blockDelete[1]);
      validateRange(line, line, lineNumber);
      current.operations.push({ kind: "block_delete", line });
      continue;
    }
    const blockInsertPost = /^INS\.BLK\.POST\s+(\d+)\s*:\s*$/.exec(trimmed);
    if (blockInsertPost) {
      const operation: HashlineOperation = { kind: "block_insert_post", line: Number(blockInsertPost[1]), lines: [] };
      validateRange(operation.line, operation.line, lineNumber);
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    const swap = /^SWAP\s+(\d+)\s*(?:\.=|\.\.|-|…|\s+)\s*(\d+)\s*:\s*$/.exec(trimmed);
    if (swap) {
      const operation: HashlineOperation = { kind: "swap", start: Number(swap[1]), end: Number(swap[2]), lines: [] };
      validateRange(operation.start, operation.end, lineNumber);
      current.operations.push(operation);
      pending = operation;
      continue;
    }
    const del = /^DEL\s+(\d+)(?:\s*(?:\.=|\.\.|-|…|\s+)\s*(\d+))?\s*$/.exec(trimmed);
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
      if ((operation.kind === "swap" || operation.kind === "insert" || operation.kind === "block_swap" || operation.kind === "block_insert_post") && operation.lines.length === 0) {
        throw new Error(`${operation.kind.toUpperCase()} operation in ${section.path} has no + payload lines`);
      }
    }
  }
  return { sections };
}

function validateRange(start: number, end: number, lineNumber: number): void {
  if (start < 1 || end < 1 || end < start) throw new Error(`line ${lineNumber}: invalid range ${start}.=${end}`);
}

export function applyHashlinePatch(session: HashlineSession, currentText: string, section: HashlineSection, options: { recordSnapshot?: boolean } = {}): ApplyResult {
  const { text: normalized, format } = normalizeTextWithFormat(currentText);
  const currentTag = computeFileTag(normalized);
  const snapshot = session.snapshot(section.path, section.tag);
  if (!snapshot) {
    throw new Error(`unknown hashline tag ${section.tag} for ${section.path}; current tag ${currentTag}. Re-read the file and retry.`);
  }
  assertSeenAnchors(section, snapshot);

  let operations = section.operations;
  const warnings: string[] = [];
  if (currentTag === section.tag && snapshot.text !== normalized) {
    throw new Error(`hashline tag collision or stale snapshot for ${section.path}; current tag ${currentTag}. Re-read the file and retry.`);
  }
  if (currentTag !== section.tag) {
    const recovered = remapStaleSection(snapshot.text, normalized, section);
    if (!recovered) {
      throw new Error(`stale tag ${section.tag} for ${section.path}; current tag ${currentTag}. Re-read the file and retry.`);
    }
    operations = recovered.operations;
    warnings.push(`Recovered stale tag ${section.tag} for ${section.path} by remapping anchors onto current content.`);
  }

  const before = normalized.split("\n");
  const lines = [...before];
  if (operations.some(isBlockOperation)) {
    warnings.push("Block operations use heuristic brace/indent resolution in this stock-Pi extension; verify the changed range or use explicit SWAP/DEL ranges if uncertain.");
  }
  operations = resolveBlockOperations(operations, lines, section.path);
  assertNoOverlappingTargets({ ...section, operations });
  const ordered = [...operations].sort((a, b) => maxAnchorLine(b) - maxAnchorLine(a));
  for (const operation of ordered) applyOperation(lines, operation);
  const text = lines.join("\n");
  const tag = computeFileTag(text);
  if (options.recordSnapshot ?? true) session.record(section.path, text);
  return {
    text,
    persisted: restoreTextFormat(text, format),
    tag,
    firstChangedLine: firstChangedLine(before, lines),
    warnings,
  };
}

export function applyHashlinePatchToFiles(session: HashlineSession, patch: HashlinePatch, io: HashlineFileIO): PreparedHashlineWrite[] {
  const seen = new Set<string>();
  for (const section of patch.sections) {
    if (seen.has(section.path)) {
      throw new Error(`Multiple hashline sections resolve to the same file (${section.path}). Merge their ops under one header before applying.`);
    }
    seen.add(section.path);
  }

  const prepared = patch.sections.map((section): PreparedHashlineWrite => {
    const current = io.readFile(section.path);
    return { path: section.path, ...applyHashlinePatch(session, current, section, { recordSnapshot: false }) };
  });

  for (const entry of prepared) io.writeFile(entry.path, entry.persisted);
  for (const entry of prepared) session.record(entry.path, entry.text);
  return prepared;
}


function remapStaleSection(previousText: string, currentText: string, section: HashlineSection): { operations: HashlineOperation[] } | undefined {
  const previousLines = previousText.split("\n");
  const currentLines = currentText.split("\n");
  const lineMap = buildUnchangedLineMap(previousLines, currentLines);
  const remapped: HashlineOperation[] = [];
  const offsets: number[] = [];
  const mapLine = (line: number): number | undefined => {
    const mapped = lineMap.get(line);
    if (mapped === undefined) return undefined;
    offsets.push(mapped - line);
    return mapped;
  };

  for (const operation of section.operations) {
    if (operation.kind === "swap") {
      const start = mapLine(operation.start);
      const end = mapLine(operation.end);
      if (start === undefined || end === undefined || end - start !== operation.end - operation.start) return undefined;
      remapped.push({ ...operation, start, end });
    } else if (operation.kind === "delete") {
      const start = mapLine(operation.start);
      const end = mapLine(operation.end);
      if (start === undefined || end === undefined || end - start !== operation.end - operation.start) return undefined;
      remapped.push({ ...operation, start, end });
    } else if (operation.kind === "insert" && operation.line !== undefined) {
      const line = mapLine(operation.line);
      if (line === undefined) return undefined;
      remapped.push({ ...operation, line });
    } else if (operation.kind === "block_swap" || operation.kind === "block_delete" || operation.kind === "block_insert_post") {
      const line = mapLine(operation.line);
      if (line === undefined) return undefined;
      remapped.push({ ...operation, line } as HashlineOperation);
    } else {
      remapped.push(operation);
    }
  }
  if (offsets.length === 0) return { operations: remapped };
  const first = offsets[0];
  if (!offsets.every((offset) => offset === first)) return undefined;
  return { operations: remapped };
}

function buildUnchangedLineMap(previousLines: string[], currentLines: string[]): Map<number, number> {
  const m = previousLines.length;
  const n = currentLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = previousLines[i] === currentLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (previousLines[i] === currentLines[j]) {
      map.set(i + 1, j + 1);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

function isBlockOperation(operation: HashlineOperation): boolean {
  return operation.kind === "block_swap" || operation.kind === "block_delete" || operation.kind === "block_insert_post";
}

function resolveBlockOperations(operations: readonly HashlineOperation[], lines: readonly string[], path: string): HashlineOperation[] {
  return operations.map((operation): HashlineOperation => {
    if (operation.kind === "block_swap") {
      const span = resolveBlockSpan(lines, operation.line, path);
      return { kind: "swap", start: span.start, end: span.end, lines: operation.lines };
    }
    if (operation.kind === "block_delete") {
      const span = resolveBlockSpan(lines, operation.line, path);
      return { kind: "delete", start: span.start, end: span.end };
    }
    if (operation.kind === "block_insert_post") {
      const span = resolveBlockSpan(lines, operation.line, path);
      return { kind: "insert", position: "post", line: span.end, lines: operation.lines };
    }
    return operation;
  });
}

function resolveBlockSpan(lines: readonly string[], anchorLine: number, path: string): { start: number; end: number } {
  if (anchorLine < 1 || anchorLine > lines.length) throw new Error(`line ${anchorLine} does not exist; file has ${lines.length} lines`);
  const startIndex = anchorLine - 1;
  const braceSpan = resolveBraceBlock(lines, startIndex);
  if (braceSpan !== undefined) return { start: anchorLine, end: braceSpan + 1 };
  const indentSpan = resolveIndentBlock(lines, startIndex);
  if (indentSpan !== undefined) return { start: anchorLine, end: indentSpan + 1 };
  throw new Error(`Could not resolve block at ${path}:${anchorLine}. Use SWAP/DEL line ranges instead.`);
}

function resolveBraceBlock(lines: readonly string[], startIndex: number): number | undefined {
  let balance = 0;
  let sawOpen = false;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { balance++; sawOpen = true; }
      else if (ch === "}") balance--;
    }
    if (sawOpen && balance <= 0) return i;
  }
  return undefined;
}

function resolveIndentBlock(lines: readonly string[], startIndex: number): number | undefined {
  const baseIndent = leadingWhitespace(lines[startIndex]);
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { end = i; continue; }
    if (leadingWhitespace(lines[i]) <= baseIndent) break;
    end = i;
  }
  return end > startIndex ? end : undefined;
}

function leadingWhitespace(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
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

function assertNoOverlappingTargets(section: HashlineSection): void {
  const targeted = new Set<number>();
  for (const operation of section.operations) {
    if (operation.kind === "insert") continue;
    for (let line = operation.start; line <= operation.end; line++) {
      if (targeted.has(line)) throw new Error(`${section.path} line ${line} is targeted by more than one SWAP/DEL operation.`);
      targeted.add(line);
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
    if (operation.kind === "block_swap" || operation.kind === "block_delete" || operation.kind === "block_insert_post") {
      lines.push(operation.line);
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

function canonicalExistingOrParent(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (existsSync(parent)) return resolve(realpathSync.native(parent), path.split(/[\\/]/).pop() ?? "");
  return resolve(path);
}

export function resolveProjectPath(cwd: string, maybePath: string): { absolutePath: string; relativePath: string } {
  const root = realpathSync.native(resolve(cwd));
  const absolutePath = canonicalExistingOrParent(isAbsolute(maybePath) ? maybePath : resolve(root, maybePath));
  const rel = relative(root, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`hashline path ${JSON.stringify(maybePath)} resolves outside project root ${root}`);
  }
  return { absolutePath, relativePath: rel.replace(/\\/g, "/") };
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
}

async function collectDiagnostics(ctx: any, paths: string[]): Promise<string[]> {
  const lsp = ctx?.lsp ?? ctx?.languageServer ?? ctx?.diagnostics;
  if (!lsp) return [];
  const out: string[] = [];
  for (const path of paths) {
    let diagnostics: unknown;
    if (typeof lsp.diagnostics === "function") diagnostics = await lsp.diagnostics(path);
    else if (typeof lsp.getDiagnostics === "function") diagnostics = await lsp.getDiagnostics(path);
    else if (typeof lsp === "function") diagnostics = await lsp(path);
    if (!Array.isArray(diagnostics)) continue;
    for (const item of diagnostics) out.push(formatDiagnostic(path, item));
  }
  return out.filter(Boolean);
}

function formatDiagnostic(path: string, item: any): string {
  const severity = item?.severity ? `${item.severity}` : "diagnostic";
  const line = item?.line ?? item?.range?.start?.line;
  const displayLine = typeof line === "number" ? line + (line === 0 ? 1 : 0) : undefined;
  const message = item?.message ?? item?.text ?? JSON.stringify(item);
  return `${path}${displayLine ? `:${displayLine}` : ""} ${severity}: ${message}`;
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
      const resolved = resolveProjectPath(cwd, (params as { path: string }).path);
      const statText = readFileSync(resolved.absolutePath, "utf8");
      if (Buffer.byteLength(statText, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw new Error(`File is larger than ${MAX_SNAPSHOT_BYTES} bytes; hashline snapshots are disabled for this file.`);
      }
      const text = formatHashlineRead(session, resolved.relativePath, statText, {
        startLine: (params as { startLine?: number }).startLine,
        endLine: (params as { endLine?: number }).endLine,
      });
      reads++;
      updateStatus(ctx);
      return { content: [{ type: "text", text }], details: { path: resolved.relativePath, tag: session.head(resolved.relativePath)?.tag } };
    },
  });

  pi.registerTool({
    name: "hashline_edit",
    label: "Hashline Edit",
    description: "Apply a hashline patch produced from hashline_read output.",
    promptSnippet: "Apply hashline edits with [path#TAG], SWAP/DEL/INS operations, and + payload lines.",
    promptGuidelines: [
      "Prefer one [path#TAG] section per file.",
      "Use SWAP N.=M: plus + payload lines to replace ranges, DEL N.=M to delete, INS.PRE/POST/HEAD/TAIL to insert.",
      "If hashline_edit reports a stale tag or unseen line, re-read the file/range before retrying.",
    ],
    parameters: Schema.Object({
      input: Schema.String({ description: "Hashline patch text." }),
    }) as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const patch = parseHashlineInput((params as { input: string }).input);
      const pathMap = new Map<string, { absolutePath: string; relativePath: string }>();
      const normalizedPatch: HashlinePatch = {
        sections: patch.sections.map((section) => {
          const resolved = resolveProjectPath(cwd, section.path);
          pathMap.set(resolved.relativePath, resolved);
          return { ...section, path: resolved.relativePath };
        }),
      };
      const prepared = applyHashlinePatchToFiles(session, normalizedPatch, {
        readFile: (filePath) => readFileSync(pathMap.get(filePath)?.absolutePath ?? resolve(cwd, filePath), "utf8"),
        writeFile: (filePath, text) => writeFileSync(pathMap.get(filePath)?.absolutePath ?? resolve(cwd, filePath), text, "utf8"),
      });
      const diagnostics = await collectDiagnostics(ctx, prepared.map((entry) => pathMap.get(entry.path)?.absolutePath ?? resolve(cwd, entry.path)));
      edits += prepared.length;
      updateStatus(ctx);
      const summary = prepared.map((entry) => {
        const warningBlock = entry.warnings.length ? `\nWarnings:\n${entry.warnings.join("\n")}` : "";
        return `${formatHashlineHeader(entry.path, entry.tag)} changed at line ${entry.firstChangedLine ?? "n/a"}${warningBlock}`;
      }).join("\n");
      const diagnosticsBlock = diagnostics.length ? `\n\nDiagnostics:\n${diagnostics.join("\n")}` : "";
      return {
        content: [{ type: "text", text: `${summary}${diagnosticsBlock}` }],
        details: { sections: prepared.length, diagnostics },
      };
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
