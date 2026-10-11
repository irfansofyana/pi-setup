import { lstatSync, readdirSync, readFileSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

export interface ImportCandidate {
  id: string;
  path: string;
  name: string;
  description: string;
  scope: "user" | "project";
  settingsPaths: string[];
}

export interface DiscoverImportOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  homeDir?: string;
  extraAgentDirs?: string;
}

const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules"]);

function isSkillDirectoryName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "skills" || normalized === ".skills";
}

function isSkillMarkdownName(name: string): boolean {
  return name.toLowerCase() === "skill.md";
}

/** True when any path segment is a skills or .skills directory, in any case. */
function isSkillPath(filePath: string): boolean {
  return normalize(filePath)
    .split(sep)
    .some((segment) => isSkillDirectoryName(segment));
}

type Scope = ImportCandidate["scope"];
type Permissive = "agents" | "broad" | "strict";

interface ScanRoot {
  directory: string;
  scope: Scope;
  permissive: Permissive;
  settingsPaths: string[];
}

interface DisplayFields {
  name?: string;
  description?: string;
  packageName?: string;
}

type Listed =
  | { kind: "absent" }
  | { kind: "symlink" }
  | { kind: "error"; message: string }
  | { kind: "ok"; stat: Stats };

/**
 * Read-only discovery of definitions the user may import from tintinweb/pi-subagents
 * and npm pi-subagents. File contents are data, not instructions: only name,
 * description, and package are read, and only for display. Nothing is migrated
 * or written. Package-provided and builtin agents are not discovery roots.
 * Skill directories and SKILL.md files are not agent definitions: they are skipped
 * before their contents are read, including when a configured root points at them.
 */
export function discoverImportCandidates(options: DiscoverImportOptions): {
  candidates: ImportCandidate[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const candidates: ImportCandidate[] = [];
  try {
    collectCandidates(options, candidates, diagnostics);
  } catch (error) {
    diagnostics.push(`Import discovery failed: ${detail(error)}`);
  }
  candidates.sort(
    (left, right) => compare(left.name, right.name) || compare(left.path, right.path),
  );
  return { candidates, diagnostics: unique(diagnostics) };
}

function collectCandidates(
  options: DiscoverImportOptions,
  candidates: ImportCandidate[],
  diagnostics: string[],
): void {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir);
  const homeDir = resolve(options.homeDir ?? homedir());
  const extraRaw = options.extraAgentDirs ?? process.env[EXTRA_AGENT_DIRS_ENV] ?? "";
  const userSettingsPath = resolve(agentDir, "settings.json");
  const userBase = realDirectory(agentDir, [], diagnostics);
  const userSettings = userBase
    ? readScanSettings(userSettingsPath, diagnostics)
    : { scanDirs: [], excludes: [] };
  const userExcludes = userSettings.excludes.map((entry) =>
    resolveLiteral(entry, agentDir, homeDir),
  );
  const managerDirs = [
    resolve(agentDir, "subagent-manager", "agents"),
    resolve(cwd, ".pi", "agent", "subagent-manager", "agents"),
  ];
  const projectRoot = options.includeProject ? findNearestProjectRoot(cwd, homeDir) : undefined;
  const projectSettingsDir = projectRoot
    ? realDirectory(projectRoot, [".pi"], diagnostics)
    : undefined;
  const projectSettingsPath = projectSettingsDir
    ? resolve(projectSettingsDir, "settings.json")
    : undefined;
  const projectSettings = projectSettingsPath
    ? readScanSettings(projectSettingsPath, diagnostics)
    : { scanDirs: [], excludes: [] };
  const projectExcludes = projectSettings.excludes.map((entry) =>
    resolveLiteral(entry, projectSettingsPath ? dirname(projectSettingsPath) : cwd, homeDir),
  );
  const mergedProjectExcludes = [...userExcludes, ...projectExcludes];
  const userSettingsPaths = userBase ? existingFiles([userSettingsPath], diagnostics) : [];
  const projectSettingsPaths = existingFiles(
    [...userSettingsPaths, ...(projectSettingsPath ? [projectSettingsPath] : [])],
    diagnostics,
  );

  const roots: ScanRoot[] = [];
  const scheduled = new Set<string>();
  const schedule = (directory: string | undefined, scope: Scope, permissive: Permissive) => {
    if (!directory) return;
    const resolved = resolve(directory);
    if (isSkillPath(resolved) || scheduled.has(resolved) || isManagerOwned(resolved, managerDirs)) {
      return;
    }
    const excludes = scope === "project" ? mergedProjectExcludes : userExcludes;
    if (isExcluded(resolved, excludes)) return;
    scheduled.add(resolved);
    roots.push({
      directory: resolved,
      scope,
      permissive,
      settingsPaths: scope === "project" ? projectSettingsPaths : userSettingsPaths,
    });
  };

  schedule(realDirectory(agentDir, ["agents"], diagnostics), "user", "agents");
  schedule(realDirectory(homeDir, [".agents"], diagnostics), "user", "broad");
  if (projectRoot) {
    schedule(realDirectory(projectRoot, [".pi", "agents"], diagnostics), "project", "agents");
    schedule(realDirectory(projectRoot, [".agents"], diagnostics), "project", "broad");
  }
  for (const directory of extraDirectories(extraRaw, cwd, homeDir, diagnostics)) {
    schedule(directory, "user", "strict");
  }
  for (const directory of expandScanDirs(
    userSettings.scanDirs,
    agentDir,
    homeDir,
    userSettingsPath,
    diagnostics,
  )) {
    schedule(directory, "user", "strict");
  }
  if (projectRoot && projectSettingsPath) {
    for (const directory of expandScanDirs(
      projectSettings.scanDirs,
      dirname(projectSettingsPath),
      homeDir,
      projectSettingsPath,
      diagnostics,
    )) {
      schedule(directory, "project", "strict");
    }
  }

  const seen = new Set<string>();
  for (const root of roots) {
    const excludes = root.scope === "project" ? mergedProjectExcludes : userExcludes;
    walk(root, excludes, managerDirs, seen, candidates, diagnostics);
  }
}

function walk(
  root: ScanRoot,
  excludes: string[],
  managerDirs: string[],
  seen: Set<string>,
  candidates: ImportCandidate[],
  diagnostics: string[],
): void {
  if (isSkillPath(root.directory)) return;
  const skipHidden = basenameOf(root.directory) === ".agents";
  const visit = (directory: string): void => {
    if (
      isSkillPath(directory) ||
      isManagerOwned(directory, managerDirs) ||
      isExcluded(directory, excludes)
    ) {
      return;
    }
    let entries: Dirent[];
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink()) return;
      if (!stat.isDirectory()) {
        diagnostics.push(`${directory}: Agent directory must be a directory`);
        return;
      }
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      diagnostics.push(`${directory}: ${detail(error)}`);
      return;
    }
    for (const entry of [...entries].sort((left, right) => compare(left.name, right.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(entry.name) || isSkillDirectoryName(entry.name)) continue;
        if (skipHidden && entry.name.startsWith(".")) continue;
        if (isManagerOwned(child, managerDirs) || isExcluded(child, excludes)) continue;
        visit(child);
        continue;
      }
      if (isSkillMarkdownName(entry.name)) continue;
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) {
        continue;
      }
      if (isExcluded(child, excludes) || isManagerOwned(child, managerDirs)) continue;
      considerFile(child, root, seen, candidates, diagnostics);
    }
  };
  visit(root.directory);
}

function considerFile(
  filePath: string,
  root: ScanRoot,
  seen: Set<string>,
  candidates: ImportCandidate[],
  diagnostics: string[],
): void {
  if (isSkillMarkdownName(basenameOf(filePath)) || isSkillPath(filePath)) return;
  const resolved = resolve(filePath);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  let content = "";
  try {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    content = readFileSync(resolved, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") diagnostics.push(`${resolved}: ${detail(error)}`);
    return;
  }
  let fields: DisplayFields;
  try {
    fields = readDisplayFields(content);
  } catch (error) {
    diagnostics.push(`${resolved}: ${detail(error)}`);
    const display = looseDisplayFields(content);
    if (!display) return;
    fields = display;
  }
  const permissive = allowsFilenameFallback(root, resolved);
  const rawName = fields.name?.trim() ?? "";
  const name = rawName || (permissive ? filenameName(resolved) : "");
  const description = fields.description ?? (permissive ? "" : undefined);
  if (!name || description === undefined || (!permissive && !description.trim())) return;
  const packageName = fields.packageName?.trim() ?? "";
  candidates.push({
    id: resolved,
    path: resolved,
    name: packageName ? `${packageName}.${name}` : name,
    description,
    scope: root.scope,
    settingsPaths: root.settingsPaths,
  });
}

// npm's parser permits non-YAML values in unrelated fields (e.g. tools: *).
// This fallback extracts only unambiguous scalar display metadata, never converts an agent.
function looseDisplayFields(content: string): DisplayFields | undefined {
  const extracted = frontmatter(content);
  if (!extracted) return undefined;
  const fields: Record<string, string> = {};
  for (const key of ["name", "description", "package"]) {
    const matches = [...extracted.yaml.matchAll(new RegExp(`^${key}:\\s*(.*)$`, "gm"))];
    if (matches.length > 1) return undefined;
    if (!matches.length) continue;
    const value = matches[0]![1]!.trim();
    if (!value || /^[&*[{>|]/.test(value)) continue;
    try {
      const scalar = parseDocument(value);
      if (scalar.errors.length) continue;
      const parsed = scalar.toJS({ maxAliasCount: 0 });
      if (typeof parsed === "string") fields[key] = parsed;
    } catch {
      /* Ambiguous display metadata is not selectable. */
    }
  }
  if (!fields.name || !fields.description) return undefined;
  return { name: fields.name, description: fields.description, packageName: fields.package };
}

/** Source text is data. Alias expansion is rejected when the document is materialized. */
function readDisplayFields(content: string): DisplayFields {
  const extracted = frontmatter(content);
  if (!extracted) return {};
  const doc = parseDocument(extracted.yaml);
  if (doc.errors.length) {
    throw new Error(doc.errors.map((error) => error.message).join("; "));
  }
  const data = doc.toJS({ maxAliasCount: 0 });
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Frontmatter must be a mapping");
  }
  const record = data as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    packageName: typeof record.package === "string" ? record.package : undefined,
  };
}

function frontmatter(content: string): { yaml: string } | undefined {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match || match.index !== 0) return undefined;
  return { yaml: match[1] };
}

function allowsFilenameFallback(root: ScanRoot, filePath: string): boolean {
  if (root.permissive === "agents") return true;
  if (root.permissive !== "broad") return false;
  const parts = relative(root.directory, filePath).split(sep);
  return parts.length === 2 && parts[0] === "agents" && parts[1].endsWith(".md");
}

function filenameName(filePath: string): string {
  const base = basenameOf(filePath);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function findNearestProjectRoot(cwd: string, homeDir: string): string | undefined {
  let current = resolve(cwd);
  const home = resolve(homeDir);
  while (current !== home) {
    const stat = listed(current);
    if (stat.kind === "ok" && stat.stat.isDirectory()) {
      if (isRealDirectory(join(current, ".pi")) || isRealDirectory(join(current, ".agents"))) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function isRealDirectory(path: string): boolean {
  const stat = listed(path);
  return stat.kind === "ok" && stat.stat.isDirectory();
}

function realDirectory(
  base: string,
  segments: string[],
  diagnostics: string[],
): string | undefined {
  let current = resolve(base);
  const accept = (path: string): boolean => {
    const stat = listed(path);
    if (stat.kind === "absent" || stat.kind === "symlink") return false;
    if (stat.kind === "error") {
      diagnostics.push(`${path}: ${stat.message}`);
      return false;
    }
    if (!stat.stat.isDirectory()) {
      diagnostics.push(`${path}: Agent directory must be a directory`);
      return false;
    }
    return true;
  };
  if (!accept(current)) return undefined;
  for (const segment of segments) {
    current = join(current, segment);
    if (!accept(current)) return undefined;
  }
  return current;
}

function extraDirectories(
  raw: string,
  cwd: string,
  homeDir: string,
  diagnostics: string[],
): string[] {
  const directories: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const target = resolve(cwd, expandTilde(trimmed, homeDir));
    if (isSkillPath(target) || hasSymlinkComponent(cwd, target)) continue;
    const stat = listed(target);
    if (stat.kind === "absent" || stat.kind === "symlink") continue;
    if (stat.kind === "error") {
      diagnostics.push(`${target}: ${stat.message}`);
      continue;
    }
    if (!stat.stat.isDirectory()) {
      diagnostics.push(`${target}: Agent directory must be a directory`);
      continue;
    }
    directories.push(target);
  }
  return directories;
}

function expandScanDirs(
  patterns: string[],
  baseDir: string,
  homeDir: string,
  settingsPath: string,
  diagnostics: string[],
): string[] {
  const directories: string[] = [];
  for (const pattern of patterns) {
    const expanded = expandTilde(pattern, homeDir).replace(/[\\/]+/g, sep);
    const absolute = isAbsolute(expanded) ? expanded : join(resolve(baseDir), expanded);
    const normalized = normalize(absolute);
    const parts = normalized.split(sep);
    const starCount = [...normalized.matchAll(/\*/g)].length;
    if (starCount === 0) {
      if (isSkillPath(normalized)) continue;
      const directory = acceptDirectory(normalized, baseDir, diagnostics);
      if (directory) directories.push(directory);
      continue;
    }
    const wildcardAt = parts.findIndex((part) => part.includes("*"));
    if (starCount !== 1 || wildcardAt < 0 || parts[wildcardAt] !== "*") {
      diagnostics.push(
        `${settingsPath}: Invalid agentScanDirs pattern '${pattern}': expected one '*' path segment`,
      );
      continue;
    }
    const wildcardBase = wildcardDirectory(parts.slice(0, wildcardAt));
    if (isSkillPath(wildcardBase) || !acceptDirectory(wildcardBase, baseDir, diagnostics)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(wildcardBase, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") diagnostics.push(`${wildcardBase}: ${detail(error)}`);
      continue;
    }
    const rest = parts.slice(wildcardAt + 1);
    for (const entry of [...entries].sort((left, right) => compare(left.name, right.name))) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || isSkillDirectoryName(entry.name)) {
        continue;
      }
      const target = join(wildcardBase, entry.name, ...rest);
      if (isSkillPath(target)) continue;
      const directory = acceptDirectory(target, wildcardBase, diagnostics);
      if (directory) directories.push(directory);
    }
  }
  return directories;
}

function wildcardDirectory(parts: string[]): string {
  if (parts.length === 0) return sep;
  const joined = parts.join(sep);
  return joined || sep;
}

function acceptDirectory(target: string, base: string, diagnostics: string[]): string | undefined {
  const resolved = resolve(target);
  if (hasSymlinkComponent(base, resolved)) return undefined;
  const stat = listed(resolved);
  if (stat.kind === "absent" || stat.kind === "symlink") return undefined;
  if (stat.kind === "error") {
    diagnostics.push(`${resolved}: ${stat.message}`);
    return undefined;
  }
  if (!stat.stat.isDirectory()) {
    diagnostics.push(`${resolved}: Agent directory must be a directory`);
    return undefined;
  }
  return resolved;
}

function readScanSettings(
  filePath: string,
  diagnostics: string[],
): { scanDirs: string[]; excludes: string[] } {
  const empty = { scanDirs: [], excludes: [] };
  const stat = listed(filePath);
  if (stat.kind === "absent" || stat.kind === "symlink") return empty;
  if (stat.kind === "error") {
    diagnostics.push(`${filePath}: ${stat.message}`);
    return empty;
  }
  if (!stat.stat.isFile()) {
    diagnostics.push(`${filePath}: Settings must be a regular file`);
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    diagnostics.push(`${filePath}: ${detail(error)}`);
    return empty;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`${filePath}: Settings must be a JSON object`);
    return empty;
  }
  const subagents = (parsed as Record<string, unknown>).subagents;
  if (subagents === undefined) return empty;
  if (subagents === null || typeof subagents !== "object" || Array.isArray(subagents)) {
    diagnostics.push(`${filePath}: subagents must be a JSON object`);
    return empty;
  }
  const record = subagents as Record<string, unknown>;
  return {
    scanDirs: stringList(record, "agentScanDirs", filePath, diagnostics),
    excludes: stringList(record, "agentExcludeDirs", filePath, diagnostics),
  };
}

function stringList(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: string[],
): string[] {
  if (!Object.hasOwn(record, key)) return [];
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    diagnostics.push(`${filePath}: subagents.${key} must be an array of non-empty strings`);
    return [];
  }
  return value.map((item: string) => item.trim());
}

function existingFiles(paths: string[], diagnostics: string[]): string[] {
  const files: string[] = [];
  for (const filePath of paths) {
    const resolved = resolve(filePath);
    const stat = listed(resolved);
    if (stat.kind === "absent" || stat.kind === "symlink") continue;
    if (stat.kind === "error") {
      diagnostics.push(`${resolved}: ${stat.message}`);
      continue;
    }
    if (!stat.stat.isFile()) {
      diagnostics.push(`${resolved}: Settings must be a regular file`);
      continue;
    }
    files.push(resolved);
  }
  return files;
}

/** Symlink checks start at the configured base, never at filesystem-root ancestors. */
function hasSymlinkComponent(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return listed(resolvedTarget).kind === "symlink";
  }
  let current = resolvedBase;
  if (listed(current).kind === "symlink") return true;
  for (const segment of rel.split(sep)) {
    if (!segment || segment === ".") continue;
    current = join(current, segment);
    if (listed(current).kind === "symlink") return true;
  }
  return false;
}

function isManagerOwned(target: string, managerDirs: string[]): boolean {
  const resolved = resolve(target);
  return managerDirs.some((directory) => isInside(directory, resolved));
}

function isExcluded(target: string, excludes: string[]): boolean {
  const resolved = resolve(target);
  return excludes.some((directory) => isInside(directory, resolved));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function resolveLiteral(entry: string, baseDir: string, homeDir: string): string {
  return resolve(baseDir, expandTilde(entry.trim(), homeDir));
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDir, value.slice(2));
  return value;
}

function listed(path: string): Listed {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? { kind: "symlink" } : { kind: "ok", stat };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "error", message: detail(error) };
  }
}

function basenameOf(path: string): string {
  const parts = path.split(sep);
  return parts[parts.length - 1] ?? path;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

