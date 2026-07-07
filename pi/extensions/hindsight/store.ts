import { existsSync, mkdirSync, readFileSync, appendFileSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryEntry } from "./types.ts";

export const HINDSIGHT_DIR = join(homedir(), ".pi", "agent", "hindsight");

export function projectBasename(cwd: string): string {
  const name = basename(resolve(cwd));
  if (!name || name === "." || name === ".." || name.includes(sep) || name.includes("/")) return "root";
  return name;
}

export function projectKey(cwd: string): string {
  const resolved = resolve(cwd);
  const rawBase = projectBasename(cwd);
  const base = rawBase.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeBase = !base || base === "." || base === ".." ? "root" : base;
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${safeBase}-${hash}`;
}

export function projectDir(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  return join(rootDir, projectKey(cwd));
}

export function memoriesPath(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  return join(projectDir(cwd, rootDir), "memories.jsonl");
}

export function memoryDocPath(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  return join(projectDir(cwd, rootDir), "MEMORY.md");
}

export function memorySummaryPath(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  return join(projectDir(cwd, rootDir), "memory_summary.md");
}

export function skillsDir(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  return join(projectDir(cwd, rootDir), "skills");
}

export function ensureDirs(cwd: string, rootDir: string = HINDSIGHT_DIR): void {
  mkdirSync(projectDir(cwd, rootDir), { recursive: true });
}

export function loadMemories(cwd: string, rootDir: string = HINDSIGHT_DIR): MemoryEntry[] {
  const path = memoriesPath(cwd, rootDir);
  if (!existsSync(path)) return [];
  const entries: MemoryEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MemoryEntry;
      if (parsed && typeof parsed.id === "string" && typeof parsed.text === "string") {
        entries.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

export function appendMemory(cwd: string, entry: MemoryEntry, rootDir: string = HINDSIGHT_DIR): void {
  ensureDirs(cwd, rootDir);
  appendFileSync(memoriesPath(cwd, rootDir), `${JSON.stringify(entry)}\n`, "utf8");
}

export function readTextFile(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function writeMemoryArtifacts(cwd: string, memoryDoc: string, summary: string, rootDir: string = HINDSIGHT_DIR): void {
  ensureDirs(cwd, rootDir);
  mkdirSync(skillsDir(cwd, rootDir), { recursive: true });
  writeFileSync(memoryDocPath(cwd, rootDir), redactSecrets(memoryDoc), "utf8");
  writeFileSync(memorySummaryPath(cwd, rootDir), redactSecrets(summary), "utf8");
}

export function clearMemories(cwd: string, rootDir: string = HINDSIGHT_DIR): void {
  for (const path of [memoriesPath(cwd, rootDir), memoryDocPath(cwd, rootDir), memorySummaryPath(cwd, rootDir)]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

export function makeMemoryEntry(cwd: string, text: string, category: string, source: "retain" | "auto-retain"): MemoryEntry {
  return {
    id: `mem_${randomUUID()}`,
    project: projectBasename(cwd),
    text,
    category: category || "general",
    createdAt: new Date().toISOString(),
    source,
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length > 0),
  );
}

export function jaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*["']?[^"'\s]{4,}/gi,
  /\b(sk-[A-Za-z0-9]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function dedupMemories(entries: MemoryEntry[], threshold = 0.8): MemoryEntry[] {
  const kept: MemoryEntry[] = [];
  for (const entry of entries) {
    const isDup = kept.some((keptEntry) => jaccard(keptEntry.text, entry.text) >= threshold);
    if (!isDup) kept.push(entry);
  }
  return kept;
}

export function searchMemories(cwd: string, query: string, limit = 5, rootDir: string = HINDSIGHT_DIR): MemoryEntry[] {
  const memories = dedupMemories(loadMemories(cwd, rootDir));
  const max = Math.max(0, limit || 5);
  if (max === 0) return [];
  const q = query.trim();
  if (!q) {
    return memories
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, max);
  }

  const queryTokens = tokenize(q);
  const now = Date.now();
  return memories
    .map((entry) => {
      const entryTokens = tokenize(`${entry.text} ${entry.category}`);
      let overlap = 0;
      for (const token of queryTokens) if (entryTokens.has(token)) overlap++;
      const categoryHit = queryTokens.has(entry.category.toLowerCase()) ? 1 : 0;
      const relevance = overlap + categoryHit;
      const ageDays = Math.max(0, (now - Date.parse(entry.createdAt)) / 86_400_000);
      const recencyBoost = Number.isFinite(ageDays) ? 1 / (1 + ageDays) : 0;
      return { entry, relevance, score: relevance + recencyBoost };
    })
    .filter((item) => item.relevance > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt))
    .slice(0, max)
    .map((item) => item.entry);
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatMemoryBlock(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";
  const lines = ["Relevant memories from past conversations (prioritize recent when conflicting):"];
  for (const memory of memories) {
    lines.push(`- [${memory.category || "general"} @ ${memory.createdAt.slice(0, 10)}] ${capText(memory.text, 500)}`);
    if (lines.join("\n").length >= 4000) break;
  }
  return capText(lines.join("\n"), 4000);
}

export function memoryGuidanceBlock(cwd: string): string {
  return [
    `Hindsight memory guidance for ${projectDir(cwd)}:`,
    `Memory artifact: ${memoriesPath(cwd)}`,
    "Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.",
    "Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.",
    "Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.",
  ].join("\n");
}

export function memorySummaryBlock(cwd: string, rootDir: string = HINDSIGHT_DIR): string {
  const summary = readTextFile(memorySummaryPath(cwd, rootDir))?.trim();
  if (!summary) return "";
  return [
    "Memory Guidance:",
    summary,
    "Treat this memory as heuristic/stale when it conflicts with current repo state or user instruction.",
  ].join("\n");
}

export function memorySourceText(cwd: string, maxChars = 80_000, rootDir: string = HINDSIGHT_DIR): string {
  const entries = dedupMemories(loadMemories(cwd, rootDir).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`## ${entry.category || "general"} @ ${entry.createdAt.slice(0, 10)} (${entry.source})`);
    lines.push(entry.text.trim());
    lines.push("");
    if (lines.join("\n").length >= maxChars) break;
  }
  return capText(lines.join("\n").trim(), maxChars);
}

export function readMemoryUrl(cwd: string, path = "memory://root", rootDir: string = HINDSIGHT_DIR): string {
  const url = path || "memory://root";
  if (url === "memory://root") {
    const artifacts = [
      `memory://root/MEMORY.md ${readTextFile(memoryDocPath(cwd, rootDir)) === undefined ? "(missing)" : ""}`.trim(),
      `memory://root/memory_summary.md ${readTextFile(memorySummaryPath(cwd, rootDir)) === undefined ? "(missing)" : ""}`.trim(),
      "memory://root/skills/",
    ];
    return artifacts.join("\n");
  }
  if (url === "memory://root/MEMORY.md") return readTextFile(memoryDocPath(cwd, rootDir)) ?? "not found: memory://root/MEMORY.md";
  if (url === "memory://root/memory_summary.md") return readTextFile(memorySummaryPath(cwd, rootDir)) ?? "not found: memory://root/memory_summary.md";
  if (url === "memory://root/skills" || url === "memory://root/skills/") {
    try {
      return readdirSync(skillsDir(cwd, rootDir)).join("\n") || "(empty)";
    } catch {
      return "(empty)";
    }
  }
  return `not found: ${url}`;
}
