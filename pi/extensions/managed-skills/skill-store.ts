import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DEFAULT_MAX_MANAGED_SKILL_BYTES, MANAGED_SKILLS_DIR } from "./config.ts";
import {
  atomicCreateFile,
  atomicWriteFile,
  ensureSafeDirectory,
  inspectRegularFile,
  lstatOrNull,
  readRegularFile,
} from "./filesystem.ts";
import type { ManagedSkillInfo, ManagedSkillWriteInput, ValidatedManagedSkillFile } from "./types.ts";

export const MANAGED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillStoreDependencies {
  atomicCreate?: typeof atomicCreateFile;
  atomicWrite?: typeof atomicWriteFile;
}

const skillMutationChains = new Map<string, Promise<unknown>>();

function serializeSkillMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = skillMutationChains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const guarded = run.catch(() => undefined);
  skillMutationChains.set(key, guarded);
  void guarded.finally(() => {
    if (skillMutationChains.get(key) === guarded) skillMutationChains.delete(key);
  });
  return run;
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

function assertPathUnderRoot(root: string, target: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  const prefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
  if (targetResolved !== rootResolved && !targetResolved.startsWith(prefix)) {
    throw new Error(`Refusing to operate outside managed-skills root: ${target}`);
  }
}

function skillPaths(root: string, name: string): { dir: string; file: string } {
  const dir = join(root, name);
  const file = join(dir, "SKILL.md");
  assertPathUnderRoot(root, dir);
  assertPathUnderRoot(root, file);
  return { dir, file };
}

export async function ensureManagedRootSafe(root = MANAGED_SKILLS_DIR): Promise<void> {
  if (!isAbsolute(root)) throw new Error(`Managed-skills root must be absolute: ${root}`);
  try {
    await ensureSafeDirectory(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/symlink/.test(message)) throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
    throw err;
  }
}

export async function discoverManagedSkillFiles(
  root = MANAGED_SKILLS_DIR,
  maxBytes = DEFAULT_MAX_MANAGED_SKILL_BYTES,
): Promise<ValidatedManagedSkillFile[]> {
  await ensureManagedRootSafe(root);
  const entries = await readdir(root, { withFileTypes: true });
  const files: ValidatedManagedSkillFile[] = [];
  for (const entry of entries) {
    if (!MANAGED_SKILL_NAME_PATTERN.test(entry.name)) continue;
    const { dir, file } = skillPaths(root, entry.name);
    try {
      const dirStat = await lstatOrNull(dir);
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
      const stat = await inspectRegularFile(file, { label: `Managed skill "${entry.name}" SKILL.md`, maxBytes });
      files.push({ name: entry.name, path: file, bytes: stat.size });
    } catch {
      continue;
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeManagedSkill(
  input: ManagedSkillWriteInput,
  dependencies: SkillStoreDependencies = {},
): Promise<{ path: string; name: string }> {
  const root = input.root ?? MANAGED_SKILLS_DIR;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_MANAGED_SKILL_BYTES;
  const name = sanitizeSkillName(input.name);
  const content = serializeManagedSkill(input);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) throw new Error(`Managed skill is ${bytes} bytes; the limit is ${maxBytes}. Trim the body or description.`);

  return serializeSkillMutation(`${resolve(root)}:${name}`, async () => {
    await ensureManagedRootSafe(root);
    const { dir, file } = skillPaths(root, name);
    const dirStat = await lstatOrNull(dir);
    if (dirStat?.isSymbolicLink()) throw new Error(`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`);
    if (dirStat && !dirStat.isDirectory()) throw new Error(`Managed skill "${name}" is not a directory; refusing to write it.`);

    if (input.action === "create") {
      await mkdir(dir, { recursive: true });
      try {
        await (dependencies.atomicCreate ?? atomicCreateFile)(file, content, { mode: 0o600 });
      } catch (err) {
        if ((err as { code?: string }).code === "EEXIST") throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`);
        throw err;
      }
      return { path: file, name };
    }

    try {
      await inspectRegularFile(file, { label: `Managed skill "${name}" SKILL.md`, maxBytes });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
      }
      throw err;
    }
    await (dependencies.atomicWrite ?? atomicWriteFile)(file, content, { mode: 0o600 });
    return { path: file, name };
  });
}

export async function deleteManagedSkill(name: string, root = MANAGED_SKILLS_DIR): Promise<void> {
  const safeName = sanitizeSkillName(name);
  await serializeSkillMutation(`${resolve(root)}:${safeName}`, async () => {
    await ensureManagedRootSafe(root);
    const { dir } = skillPaths(root, safeName);
    const stat = await lstatOrNull(dir);
    if (!stat) throw new Error(`Managed skill "${safeName}" does not exist.`);
    if (stat.isSymbolicLink()) throw new Error(`Managed skill "${safeName}" is a symlink; refusing to delete outside the managed directory.`);
    if (!stat.isDirectory()) throw new Error(`Managed skill "${safeName}" is not a directory; refusing to delete it.`);
    await rm(dir, { recursive: true, force: false });
  });
}

function parseYamlString(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1).replace(/''/g, "'");
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
  const result: { name?: string; description?: string } = {};
  for (const line of content.slice(4, end).split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = parseYamlString(line.slice(index + 1));
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

export async function listManagedSkills(
  root = MANAGED_SKILLS_DIR,
  maxBytes = DEFAULT_MAX_MANAGED_SKILL_BYTES,
): Promise<ManagedSkillInfo[]> {
  const files = await discoverManagedSkillFiles(root, maxBytes);
  const skills = await Promise.all(files.map(async (fileInfo) => {
    const content = await readRegularFile(fileInfo.path, {
      label: `Managed skill "${fileInfo.name}" SKILL.md`,
      maxBytes,
    });
    const frontmatter = parseSkillFrontmatter(content);
    return {
      name: frontmatter.name && MANAGED_SKILL_NAME_PATTERN.test(frontmatter.name) ? frontmatter.name : fileInfo.name,
      description: sanitizeManagedDescription(frontmatter.description ?? ""),
      path: fileInfo.path,
      bytes: fileInfo.bytes,
    };
  }));
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function viewManagedSkill(
  name: string,
  root = MANAGED_SKILLS_DIR,
  maxBytes = DEFAULT_MAX_MANAGED_SKILL_BYTES,
): Promise<{ path: string; content: string }> {
  const safeName = sanitizeSkillName(name);
  await ensureManagedRootSafe(root);
  const { dir, file } = skillPaths(root, safeName);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat) throw new Error(`Managed skill "${safeName}" does not exist.`);
  if (dirStat.isSymbolicLink()) throw new Error(`Managed skill "${safeName}" resolves through a symlink; refusing to read outside the managed directory.`);
  if (!dirStat.isDirectory()) throw new Error(`Managed skill "${safeName}" is not a directory; refusing to read it.`);
  try {
    const content = await readRegularFile(file, { label: `Managed skill "${safeName}" SKILL.md`, maxBytes });
    return { path: file, content };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") throw new Error(`Managed skill "${safeName}" does not exist.`);
    throw err;
  }
}

export function formatManagedSkillPath(path: string): string {
  return relative(MANAGED_SKILLS_DIR, path);
}
