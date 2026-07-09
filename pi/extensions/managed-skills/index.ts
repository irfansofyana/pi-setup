import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { lstat, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTIONAL_SCHEMA = Symbol("optional");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };

const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => !schema[OPTIONAL_SCHEMA])
      .map(([name]) => name);
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
        const { [OPTIONAL_SCHEMA]: _optional, ...cleanSchema } = schema;
        return [name, cleanSchema];
      })),
      required,
      additionalProperties: false,
    };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Number(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "number", ...options };
  },
  Boolean(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "boolean", ...options };
  },
  Enum(values: readonly string[]): JsonSchema {
    return { type: "string", enum: [...values] };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

export type ManagedSkillAction = "create" | "update" | "delete" | "list" | "view";

export interface ManagedSkillsConfig {
  enabled: boolean;
  learnEnabled: boolean;
  autoCapture: boolean;
  autoContinue: boolean;
  minToolCalls: number;
  maxSkillBytes: number;
  maxMemoryChars: number;
}

export interface ManagedSkillWriteInput {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
  root?: string;
  maxBytes?: number;
}

export interface ManagedSkillInfo {
  name: string;
  description: string;
  path: string;
  bytes: number;
}

export interface ManageSkillParams {
  action: ManagedSkillAction;
  name?: string;
  description?: string;
  body?: string;
}

export interface LearnSkillInput {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
}

export interface LearnParams {
  memory: string;
  context?: string;
  skill?: LearnSkillInput;
}

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

export interface HindsightRetainConfig {
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  scoping: HindsightScoping;
  requestTimeoutMs: number;
}

export interface BankScope {
  bankId: string;
  tags?: string[];
  tagsMatch?: "any" | "all";
}

export const DEFAULT_MAX_MANAGED_SKILL_BYTES = 64_000;
export const DEFAULT_MAX_LEARN_MEMORY_CHARS = 12_000;
export const DEFAULT_CONFIG: ManagedSkillsConfig = {
  enabled: true,
  learnEnabled: true,
  autoCapture: false,
  autoContinue: false,
  minToolCalls: 5,
  maxSkillBytes: DEFAULT_MAX_MANAGED_SKILL_BYTES,
  maxMemoryChars: DEFAULT_MAX_LEARN_MEMORY_CHARS,
};

export const MANAGED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_DIR = join(homedir(), ".pi", "agent");
const MANAGED_SKILLS_DIR = join(AGENT_DIR, "managed-skills");
const CONFIG_PATH = join(MANAGED_SKILLS_DIR, "config.json");
const HINDSIGHT_CONFIG_PATH = join(AGENT_DIR, "hindsight", "config.json");

const manageSkillSchema = Schema.Object({
  action: Schema.Enum(["create", "update", "delete", "list", "view"] as const),
  name: Schema.Optional(Schema.String({ description: "Kebab-case managed skill name." })),
  description: Schema.Optional(Schema.String({ description: "One-line trigger-focused description for create/update." })),
  body: Schema.Optional(Schema.String({ description: "SKILL.md body in Markdown, without frontmatter, for create/update." })),
});

const learnSkillSchema = Schema.Object({
  action: Schema.Enum(["create", "update"] as const),
  name: Schema.String({ description: "Kebab-case managed skill name." }),
  description: Schema.String({ description: "One-line trigger-focused description for the managed skill." }),
  body: Schema.String({ description: "SKILL.md body in Markdown, without frontmatter." }),
});

const learnSchema = Schema.Object({
  memory: Schema.String({ description: "Durable, self-contained lesson to retain in Hindsight: what, when, and why." }),
  context: Schema.Optional(Schema.String({ description: "Optional source context for the lesson." })),
  skill: Schema.Optional(learnSkillSchema),
});

const configSchema = Schema.Object({
  enabled: Schema.Optional(Schema.Boolean({ description: "Whether managed skills are enabled and discovered." })),
  learnEnabled: Schema.Optional(Schema.Boolean({ description: "Whether to register the Hindsight-backed learn tool." })),
  autoCapture: Schema.Optional(Schema.Boolean({ description: "Whether to add standing guidance to capture reusable procedures and lessons." })),
  autoContinue: Schema.Optional(Schema.Boolean({ description: "Whether to run one hidden capture turn after large tool-heavy turns." })),
  minToolCalls: Schema.Optional(Schema.Number({ description: "Minimum tool calls before autoContinue can run." })),
  maxSkillBytes: Schema.Optional(Schema.Number({ description: "Maximum serialized SKILL.md size in bytes." })),
  maxMemoryChars: Schema.Optional(Schema.Number({ description: "Maximum Hindsight learn memory length in characters." })),
});

const skillMutationChains = new Map<string, Promise<unknown>>();

function serializeSkillMutation<T>(name: string, op: () => Promise<T>): Promise<T> {
  const previous = skillMutationChains.get(name) ?? Promise.resolve();
  const run = previous.then(op, op);
  const guarded = run.catch(() => undefined);
  skillMutationChains.set(name, guarded);
  void guarded.finally(() => {
    if (skillMutationChains.get(name) === guarded) skillMutationChains.delete(name);
  });
  return run;
}

export function getManagedSkillsDir(): string {
  return MANAGED_SKILLS_DIR;
}

export function getManagedSkillsConfigPath(): string {
  return CONFIG_PATH;
}

export function sanitizeSkillName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!MANAGED_SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`);
  }
  return name;
}

export function sanitizeManagedDescription(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>`]/g, "")
    .replace(/~{2,}/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}

export function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

export function toSkillFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${yamlQuoted(sanitizeManagedDescription(description))}\n---\n`;
}

export function serializeManagedSkill(input: Pick<ManagedSkillWriteInput, "name" | "description" | "body">): string {
  const name = sanitizeSkillName(input.name);
  const description = sanitizeManagedDescription(input.description);
  const body = input.body.trim();
  if (!description) throw new Error(`Managed skill "${name}" needs a non-empty description.`);
  if (!body) throw new Error(`Managed skill "${name}" needs a non-empty body.`);
  return `${toSkillFrontmatter(name, description)}\n${body}\n`;
}

export function normalizeManagedSkillsConfig(value: unknown): ManagedSkillsConfig {
  const obj = value && typeof value === "object" ? value as Partial<ManagedSkillsConfig> : {};
  const maxSkillBytes = Number.isFinite(obj.maxSkillBytes) && Number(obj.maxSkillBytes) > 0
    ? Math.floor(Number(obj.maxSkillBytes))
    : DEFAULT_CONFIG.maxSkillBytes;
  const minToolCalls = Number.isFinite(obj.minToolCalls) && Number(obj.minToolCalls) >= 0
    ? Math.floor(Number(obj.minToolCalls))
    : DEFAULT_CONFIG.minToolCalls;
  const maxMemoryChars = Number.isFinite(obj.maxMemoryChars) && Number(obj.maxMemoryChars) > 0
    ? Math.floor(Number(obj.maxMemoryChars))
    : DEFAULT_CONFIG.maxMemoryChars;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    learnEnabled: typeof obj.learnEnabled === "boolean" ? obj.learnEnabled : DEFAULT_CONFIG.learnEnabled,
    autoCapture: typeof obj.autoCapture === "boolean" ? obj.autoCapture : DEFAULT_CONFIG.autoCapture,
    autoContinue: typeof obj.autoContinue === "boolean" ? obj.autoContinue : DEFAULT_CONFIG.autoContinue,
    minToolCalls,
    maxSkillBytes,
    maxMemoryChars,
  };
}

export function readManagedSkillsConfig(configPath = CONFIG_PATH): ManagedSkillsConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return normalizeManagedSkillsConfig(parsed);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeManagedSkillsConfig(config: ManagedSkillsConfig, configPath = CONFIG_PATH): Promise<void> {
  await ensureManagedRootSafe(dirname(configPath));
  await writeFile(configPath, `${JSON.stringify(normalizeManagedSkillsConfig(config), null, 2)}\n`, "utf8");
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*["']?[^"'\s]{4,}/gi,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export function sanitizeLearnText(text: string, maxChars = DEFAULT_MAX_LEARN_MEMORY_CHARS): string {
  const redacted = redactSecrets(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) throw new Error("Lesson was empty after sanitization; nothing stored.");
  if (redacted.length > maxChars) throw new Error(`Lesson is ${redacted.length} chars; the limit is ${maxChars}. Trim the memory.`);
  return redacted;
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(...values: Array<unknown>): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function numberValue(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return undefined;
}

function enumValue<T extends string>(allowed: readonly T[], ...values: Array<unknown>): T | undefined {
  for (const value of values) if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return undefined;
}

export function readHindsightRetainConfig(env: NodeJS.ProcessEnv = process.env): HindsightRetainConfig {
  const configPath = env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH;
  const fileConfig = readJsonObject(configPath);
  return {
    apiUrl: stringValue(env.HINDSIGHT_API_URL, fileConfig.apiUrl, "http://127.0.0.1:8888"),
    apiToken: stringValue(env.HINDSIGHT_API_TOKEN, env.HINDSIGHT_API_KEY) || undefined,
    bankId: stringValue(env.HINDSIGHT_BANK_ID, fileConfig.bankId, "coding-agent"),
    scoping: enumValue(["global", "per-project", "per-project-tagged"] as const, env.HINDSIGHT_SCOPING, fileConfig.scoping) ?? "per-project-tagged",
    requestTimeoutMs: numberValue(env.HINDSIGHT_REQUEST_TIMEOUT_MS, fileConfig.requestTimeoutMs) ?? 30_000,
  };
}

function projectBasename(cwd: string): string {
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

function safeBankPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function projectTag(cwd: string): string {
  return `project:${projectKey(cwd)}`;
}

export function computeHindsightScope(config: Pick<HindsightRetainConfig, "bankId" | "scoping">, cwd: string): BankScope {
  if (config.scoping === "global") return { bankId: config.bankId };
  if (config.scoping === "per-project") return { bankId: `${safeBankPart(config.bankId)}-${safeBankPart(projectKey(cwd))}` };
  return { bankId: config.bankId, tags: [projectTag(cwd)], tagsMatch: "any" };
}

export async function retainHindsightLesson(input: {
  cwd: string;
  memory: string;
  context?: string;
  config?: HindsightRetainConfig;
  maxMemoryChars?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ bankId: string; tags?: string[] }> {
  const config = input.config ?? readHindsightRetainConfig();
  const scope = computeHindsightScope(config, input.cwd);
  const memory = sanitizeLearnText(input.memory, input.maxMemoryChars ?? DEFAULT_MAX_LEARN_MEMORY_CHARS);
  const context = input.context ? sanitizeLearnText(input.context, input.maxMemoryChars ?? DEFAULT_MAX_LEARN_MEMORY_CHARS) : undefined;
  const timeoutSignal = config.requestTimeoutMs > 0 ? AbortSignal.timeout(config.requestTimeoutMs) : undefined;
  const requestSignal = input.signal && timeoutSignal ? AbortSignal.any([input.signal, timeoutSignal]) : (input.signal ?? timeoutSignal);
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${config.apiUrl.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories`;
  const response = await fetchImpl(url, {
    method: "POST",
    signal: requestSignal,
    headers: {
      "Content-Type": "application/json",
      ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
    },
    body: JSON.stringify({
      items: [{
        content: memory,
        context,
        tags: scope.tags,
        metadata: {
          source: "managed-skills-learn",
          cwd: resolve(input.cwd),
          tool: "learn",
        },
      }],
      async: true,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Hindsight retain failed (${response.status}): ${text}`);
  return { bankId: scope.bankId, tags: scope.tags };
}

function assertPathUnderRoot(root: string, target: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  const prefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
  if (targetResolved !== rootResolved && !targetResolved.startsWith(prefix)) {
    throw new Error(`Refusing to operate outside managed-skills root: ${target}`);
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export async function ensureManagedRootSafe(root = MANAGED_SKILLS_DIR): Promise<void> {
  if (!isAbsolute(root)) throw new Error(`Managed-skills root must be absolute: ${root}`);
  const before = await lstatOrNull(root);
  if (before?.isSymbolicLink()) {
    throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
  }
  if (before && !before.isDirectory()) {
    throw new Error(`Managed-skills root is not a directory: ${root}`);
  }
  if (!before) mkdirSync(root, { recursive: true });
  const after = await lstat(root);
  if (after.isSymbolicLink()) {
    throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
  }
  if (!after.isDirectory()) {
    throw new Error(`Managed-skills root is not a directory: ${root}`);
  }
}

function skillPaths(root: string, safeName: string): { dir: string; file: string } {
  const dir = join(root, safeName);
  const file = join(dir, "SKILL.md");
  assertPathUnderRoot(root, dir);
  assertPathUnderRoot(root, file);
  return { dir, file };
}

function assertRegularSingleLinkSkillFile(name: string, fileStat: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number }): void {
  if (fileStat.isSymbolicLink()) throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
  if (!fileStat.isFile()) throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
  if (fileStat.nlink > 1) throw new Error(`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite it.`);
}

export async function writeManagedSkill(input: ManagedSkillWriteInput): Promise<{ path: string; name: string }> {
  const root = input.root ?? MANAGED_SKILLS_DIR;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_MANAGED_SKILL_BYTES;
  const name = sanitizeSkillName(input.name);
  const content = serializeManagedSkill(input);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) throw new Error(`Managed skill is ${bytes} bytes; the limit is ${maxBytes}. Trim the body or description.`);

  return serializeSkillMutation(`${root}:${name}`, async () => {
    await ensureManagedRootSafe(root);
    const { dir, file } = skillPaths(root, name);
    const dirStat = await lstatOrNull(dir);
    if (dirStat?.isSymbolicLink()) throw new Error(`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`);

    if (input.action === "create") {
      mkdirSync(dir, { recursive: true });
      try {
        await writeFile(file, content, { flag: "wx" });
      } catch (err) {
        if ((err as { code?: string }).code === "EEXIST") throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`);
        throw err;
      }
      return { path: file, name };
    }

    const fileStat = await lstatOrNull(file);
    if (!fileStat) throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
    assertRegularSingleLinkSkillFile(name, fileStat);
    const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    try {
      const openStat = await handle.stat();
      assertRegularSingleLinkSkillFile(name, openStat);
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return { path: file, name };
  });
}

export async function deleteManagedSkill(name: string, root = MANAGED_SKILLS_DIR): Promise<void> {
  const safeName = sanitizeSkillName(name);
  await serializeSkillMutation(`${root}:${safeName}`, async () => {
    await ensureManagedRootSafe(root);
    const { dir } = skillPaths(root, safeName);
    const dirStat = await lstatOrNull(dir);
    if (!dirStat) throw new Error(`Managed skill "${safeName}" does not exist.`);
    if (dirStat.isSymbolicLink()) throw new Error(`Managed skill "${safeName}" is a symlink; refusing to delete outside the managed directory.`);
    if (!dirStat.isDirectory()) throw new Error(`Managed skill "${safeName}" is not a directory; refusing to delete it.`);
    await rm(dir, { recursive: true, force: false });
  });
}

function parseYamlString(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      if (value.startsWith('"')) return JSON.parse(value);
      return value.slice(1, -1).replace(/''/g, "'");
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end < 0) return {};
  const frontmatter = content.slice(4, end).split("\n");
  const out: { name?: string; description?: string } = {};
  for (const line of frontmatter) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = parseYamlString(line.slice(idx + 1));
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}

export async function listManagedSkills(root = MANAGED_SKILLS_DIR): Promise<ManagedSkillInfo[]> {
  await ensureManagedRootSafe(root);
  const entries = readdirSync(root, { withFileTypes: true });
  const skills: ManagedSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!MANAGED_SKILL_NAME_PATTERN.test(entry.name)) continue;
    const file = join(root, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    const content = await readFile(file, "utf8");
    const fm = parseSkillFrontmatter(content);
    skills.push({
      name: fm.name && MANAGED_SKILL_NAME_PATTERN.test(fm.name) ? fm.name : entry.name,
      description: sanitizeManagedDescription(fm.description ?? ""),
      path: file,
      bytes: stat.size,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function viewManagedSkill(name: string, root = MANAGED_SKILLS_DIR): Promise<{ path: string; content: string }> {
  const safeName = sanitizeSkillName(name);
  await ensureManagedRootSafe(root);
  const { file } = skillPaths(root, safeName);
  const stat = await lstatOrNull(file);
  if (!stat) throw new Error(`Managed skill "${safeName}" does not exist.`);
  assertRegularSingleLinkSkillFile(safeName, stat);
  return { path: file, content: await readFile(file, "utf8") };
}

function formatSkillList(skills: ManagedSkillInfo[]): string {
  if (!skills.length) return "No managed skills.";
  return skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"} (${relative(MANAGED_SKILLS_DIR, skill.path)})`).join("\n");
}

function formatStatus(config: ManagedSkillsConfig, skills: ManagedSkillInfo[]): string {
  return [
    `Managed skills: ${config.enabled ? "enabled" : "disabled"}`,
    `Root: ${MANAGED_SKILLS_DIR}`,
    `Config: ${CONFIG_PATH}`,
    `Skills: ${skills.length}`,
    `Learn tool: ${config.learnEnabled ? "on" : "off"}`,
    `Auto capture guidance: ${config.autoCapture ? "on" : "off"}`,
    `Auto continue capture: ${config.autoContinue ? "on" : "off"}`,
    `Minimum tool calls: ${config.minToolCalls}`,
    `Max skill bytes: ${config.maxSkillBytes}`,
    `Max memory chars: ${config.maxMemoryChars}`,
  ].join("\n");
}

function parseCommand(args: string): { command: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { command: "status", rest: "" };
  const [command = "status", ...rest] = trimmed.split(/\s+/);
  return { command: command.toLowerCase(), rest: rest.join(" ") };
}

function boolFromOnOff(value: string): boolean | undefined {
  if (["on", "true", "yes", "enable", "enabled"].includes(value.toLowerCase())) return true;
  if (["off", "false", "no", "disable", "disabled"].includes(value.toLowerCase())) return false;
  return undefined;
}

function notify(ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void } }, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui?.notify?.(message, level);
}

function buildAutoCaptureGuidance(config: ManagedSkillsConfig): string {
  return [
    "\n\n## Managed Skills (experimental)",
    "When you discover a durable fact, convention, user preference, or non-obvious fix, call `learn` to retain it in Hindsight.",
    "When you discover a reusable procedure, call `manage_skill` or call `learn` with a `skill` object to also create/update an isolated managed skill.",
    `Managed skills are SKILL.md files under ${MANAGED_SKILLS_DIR} and become active after /reload.`,
    "Use this sparingly for repeatable setup sequences, debugging recipes, and project workflows.",
    "Never store secrets, credentials, tokens, or one-off facts in managed skills. Never store secrets in Hindsight.",
    `Current config: learn=${config.learnEnabled}, autoCapture=${config.autoCapture}, autoContinue=${config.autoContinue}, minToolCalls=${config.minToolCalls}.`,
  ].join("\n");
}

const AUTO_CAPTURE_PROMPT = [
  "Automated managed-skill/learn capture turn — not a user reply.",
  "The user has not answered any pending question. Do not treat this as approval to continue prior work.",
  "If the previous turn produced a durable fact, convention, user preference, or non-obvious fix, call `learn` to retain it in Hindsight.",
  "If it produced a genuinely reusable procedure, call `manage_skill`, or call `learn` with a `skill` object when the lesson is both fact and procedure.",
  "Skip secrets, credentials, one-off facts, and vague lessons.",
  "After any useful capture, stop. Do not run other tools or continue the prior task.",
].join("\n");

export default function managedSkillsExtension(pi: ExtensionAPI) {
  let config = readManagedSkillsConfig();
  let toolCallsThisTurn = 0;
  let suppressNextAgentEnd = false;
  let authoredSkillNames = new Set<string>();

  pi.registerCommand("managed-skills", {
    description: "Manage isolated generated skills",
    handler: async (args, ctx) => {
      config = readManagedSkillsConfig();
      const parsed = parseCommand(args);
      try {
        if (parsed.command === "status") {
          const skills = config.enabled ? await listManagedSkills() : [];
          notify(ctx, formatStatus(config, skills));
          return;
        }
        if (parsed.command === "list") {
          notify(ctx, formatSkillList(await listManagedSkills()));
          return;
        }
        if (parsed.command === "enable" || parsed.command === "disable") {
          config = { ...config, enabled: parsed.command === "enable" };
          await writeManagedSkillsConfig(config);
          notify(ctx, `Managed skills ${config.enabled ? "enabled" : "disabled"}. Run /reload to apply discovery/tool changes.`);
          return;
        }
        if (parsed.command === "learn") {
          const enabled = boolFromOnOff(parsed.rest);
          if (enabled === undefined) {
            notify(ctx, "Usage: /managed-skills learn on|off", "warning");
            return;
          }
          config = { ...config, learnEnabled: enabled };
          await writeManagedSkillsConfig(config);
          notify(ctx, `Managed skills learn tool ${enabled ? "enabled" : "disabled"}. Run /reload to apply.`);
          return;
        }
        if (parsed.command === "auto") {
          const enabled = boolFromOnOff(parsed.rest);
          if (enabled === undefined) {
            notify(ctx, "Usage: /managed-skills auto on|off", "warning");
            return;
          }
          config = { ...config, autoCapture: enabled };
          await writeManagedSkillsConfig(config);
          notify(ctx, `Managed skills auto-capture guidance ${enabled ? "enabled" : "disabled"}. Run /reload to apply.`);
          return;
        }
        if (parsed.command === "autocontinue") {
          const enabled = boolFromOnOff(parsed.rest);
          if (enabled === undefined) {
            notify(ctx, "Usage: /managed-skills autocontinue on|off", "warning");
            return;
          }
          config = { ...config, autoContinue: enabled };
          await writeManagedSkillsConfig(config);
          notify(ctx, `Managed skills auto-continue capture ${enabled ? "enabled" : "disabled"}. Run /reload to apply.`);
          return;
        }
        if (parsed.command === "view" || parsed.command === "open") {
          if (!parsed.rest) {
            notify(ctx, `Usage: /managed-skills ${parsed.command} <name>`, "warning");
            return;
          }
          const skill = await viewManagedSkill(parsed.rest);
          notify(ctx, `${skill.path}\n\n${skill.content.slice(0, 2000)}${skill.content.length > 2000 ? "\n…" : ""}`);
          return;
        }
        if (parsed.command === "delete") {
          if (!parsed.rest) {
            notify(ctx, "Usage: /managed-skills delete <name>", "warning");
            return;
          }
          const name = sanitizeSkillName(parsed.rest);
          const ok = ctx.hasUI ? await ctx.ui.confirm("Delete managed skill?", `${name}\n\nThis removes only ${join(MANAGED_SKILLS_DIR, name)}.`) : false;
          if (!ok) {
            notify(ctx, "Delete cancelled.", "warning");
            return;
          }
          await deleteManagedSkill(name);
          notify(ctx, `Deleted managed skill "${name}". Run /reload to apply.`);
          return;
        }
        if (parsed.command === "config") {
          notify(ctx, `${CONFIG_PATH}\n\n${JSON.stringify(config, null, 2)}`);
          return;
        }
        if (parsed.command === "reload") {
          await ctx.reload();
          return;
        }
        notify(ctx, "Usage: /managed-skills status|list|enable|disable|learn on|off|auto on|off|autocontinue on|off|view <name>|delete <name>|config|reload", "warning");
      } catch (err) {
        notify(ctx, err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.on("resources_discover", async () => {
    config = readManagedSkillsConfig();
    if (!config.enabled) return {};
    await ensureManagedRootSafe(MANAGED_SKILLS_DIR);
    return { skillPaths: [MANAGED_SKILLS_DIR] };
  });

  pi.on("before_agent_start", async (event) => {
    config = readManagedSkillsConfig();
    const managedRoot = resolve(MANAGED_SKILLS_DIR);
    const skills = (event.systemPromptOptions?.skills ?? []) as Array<{ name?: string; filePath?: string; path?: string; sourceInfo?: { path?: string } }>;
    authoredSkillNames = new Set();
    for (const skill of skills) {
      const pathValue = skill.filePath ?? skill.path ?? skill.sourceInfo?.path ?? "";
      const resolvedPath = pathValue ? resolve(pathValue) : "";
      const isManaged = resolvedPath === managedRoot || resolvedPath.startsWith(`${managedRoot}${sep}`);
      if (!isManaged && typeof skill.name === "string") authoredSkillNames.add(skill.name);
    }
    if (!config.enabled || !config.autoCapture) return;
    return { systemPrompt: `${event.systemPrompt}${buildAutoCaptureGuidance(config)}` };
  });

  if (config.enabled) {
    pi.registerTool({
      name: "manage_skill",
      label: "Manage Skill",
      description: "Create, update, delete, list, or view isolated managed Pi skills under ~/.pi/agent/managed-skills.",
      promptSnippet: "Create, update, delete, list, or view isolated managed SKILL.md files.",
      promptGuidelines: [
        "Use manage_skill only for repeatable procedures worth reusing as Pi skills, not for one-off facts.",
        "manage_skill writes only isolated generated skills under ~/.pi/agent/managed-skills; never use it for secrets or credentials.",
        "After manage_skill creates, updates, or deletes a skill, tell the user to run /reload before relying on the change.",
      ],
      parameters: manageSkillSchema as any,
      async execute(_toolCallId, params: ManageSkillParams) {
        config = readManagedSkillsConfig();
        if (!config.enabled) throw new Error("Managed skills are disabled. Run /managed-skills enable, then /reload.");
        const action = params.action;
        if (action === "list") {
          const skills = await listManagedSkills();
          return { content: [{ type: "text", text: formatSkillList(skills) }], details: { action, skills } };
        }
        if (!params.name) throw new Error(`"${action}" requires "name".`);
        const name = sanitizeSkillName(params.name);
        if (action === "view") {
          const skill = await viewManagedSkill(name);
          return { content: [{ type: "text", text: skill.content }], details: { action, name, path: skill.path } };
        }
        if (action === "delete") {
          await deleteManagedSkill(name);
          return { content: [{ type: "text", text: `Deleted managed skill "${name}". Run /reload before relying on skill discovery changes.` }], details: { action, name } };
        }
        if (action !== "create" && action !== "update") throw new Error(`Unsupported action: ${action}`);
        if (!params.description || !params.body) throw new Error(`"${action}" requires "description" and "body".`);
        if (action === "create" && authoredSkillNames.has(name)) {
          return {
            content: [{ type: "text", text: `Cannot create managed skill "${name}": an authored skill with that name already exists and managed skills cannot override authored skills.` }],
            isError: true,
            details: { action, name, shadowed: true },
          };
        }
        const result = await writeManagedSkill({
          action,
          name,
          description: params.description,
          body: params.body,
          maxBytes: config.maxSkillBytes,
        });
        const verb = action === "create" ? "Created" : "Updated";
        return {
          content: [{ type: "text", text: `${verb} managed skill "${result.name}" (${relative(MANAGED_SKILLS_DIR, result.path)}). Run /reload before relying on it.` }],
          details: { action, name: result.name, path: result.path },
        };
      },
    });

    if (config.learnEnabled) {
      pi.registerTool({
        name: "learn",
        label: "Learn",
        description: "Retain a durable lesson in Hindsight and optionally create or update a managed skill in the same call.",
        promptSnippet: "Retain durable facts/preferences in Hindsight; optionally create/update a managed skill for repeatable procedures.",
        promptGuidelines: [
          "Use learn for durable facts, project conventions, user preferences, non-obvious fixes, or tool quirks that should survive future sessions.",
          "Use learn with a skill object only when the lesson is both a durable memory and a repeatable procedure worth codifying as a SKILL.md.",
          "Never pass secrets, tokens, passwords, API keys, or raw large logs to learn.",
        ],
        parameters: learnSchema as any,
        async execute(_toolCallId, params: LearnParams, signal, _onUpdate, ctx) {
          config = readManagedSkillsConfig();
          if (!config.enabled) throw new Error("Managed skills are disabled. Run /managed-skills enable, then /reload.");
          if (!config.learnEnabled) throw new Error("The learn tool is disabled. Run /managed-skills learn on, then /reload.");
          if (!params.memory) throw new Error("learn requires a non-empty memory.");

          const cwd = ctx.cwd || process.cwd();
          const retained = await retainHindsightLesson({
            cwd,
            memory: params.memory,
            context: params.context,
            maxMemoryChars: config.maxMemoryChars,
            signal,
          });

          if (!params.skill) {
            return {
              content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}).` }],
              details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: null },
            };
          }

          const skillName = sanitizeSkillName(params.skill.name);
          if (params.skill.action === "create" && authoredSkillNames.has(skillName)) {
            return {
              content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}). Did not create managed skill "${skillName}": an authored skill with that name already exists.` }],
              isError: true,
              details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: null, shadowed: true },
            };
          }

          try {
            const result = await writeManagedSkill({
              action: params.skill.action,
              name: skillName,
              description: params.skill.description,
              body: params.skill.body,
              maxBytes: config.maxSkillBytes,
            });
            const verb = params.skill.action === "create" ? "Created" : "Updated";
            return {
              content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}). ${verb} managed skill "${result.name}" (${relative(MANAGED_SKILLS_DIR, result.path)}). Run /reload before relying on it.` }],
              details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: result.name, path: result.path },
            };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`Lesson queued for Hindsight (${retained.bankId}), but the managed skill could not be written: ${reason}`);
          }
        },
      });
    }
  }

  pi.on("agent_start", async () => {
    toolCallsThisTurn = 0;
  });

  pi.on("tool_execution_end", async () => {
    toolCallsThisTurn += 1;
  });

  pi.on("agent_end", async () => {
    config = readManagedSkillsConfig();
    const toolCalls = toolCallsThisTurn;
    toolCallsThisTurn = 0;
    if (suppressNextAgentEnd) {
      suppressNextAgentEnd = false;
      return;
    }
    if (!config.enabled || !config.autoContinue) return;
    if (toolCalls < config.minToolCalls) return;
    suppressNextAgentEnd = true;
    pi.sendMessage({
      customType: "managed-skills-autocapture",
      content: AUTO_CAPTURE_PROMPT,
      display: false,
      details: { toolCalls, minToolCalls: config.minToolCalls },
    }, { deliverAs: "nextTurn", triggerTurn: true });
  });
}
