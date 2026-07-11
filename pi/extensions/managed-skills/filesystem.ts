import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface RegularFileReadOptions {
  label: string;
  maxBytes: number;
}

export interface AtomicWriteOptions {
  mode?: number;
  beforeRename?: (temporaryPath: string) => Promise<void> | void;
}

export async function inspectRegularFile(path: string, options: RegularFileReadOptions): Promise<{ size: number }> {
  const pathStat = await lstat(path);
  assertRegularSingleLinkFile(options.label, pathStat, options.maxBytes);
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = await handle.stat();
    assertRegularSingleLinkFile(options.label, stat, options.maxBytes);
    return { size: stat.size };
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function assertRegularSingleLinkFile(
  label: string,
  stat: { isFile(): boolean; isSymbolicLink?(): boolean; nlink: number; size: number },
  maxBytes: number,
): void {
  if (stat.isSymbolicLink?.()) throw new Error(`${label} is a symlink; refusing to read it.`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file; refusing to read it.`);
  if (stat.nlink > 1) throw new Error(`${label} has ${stat.nlink} hard links; refusing to read it.`);
  if (stat.size > maxBytes) throw new Error(`${label} is ${stat.size} bytes; the limit is ${maxBytes}.`);
}

export async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export async function ensureSafeDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`Managed-skills directory must be absolute: ${path}`);
  const before = await lstatOrNull(path);
  if (before?.isSymbolicLink()) throw new Error(`Managed-skills directory is a symlink: ${path}`);
  if (before && !before.isDirectory()) throw new Error(`Managed-skills path is not a directory: ${path}`);
  if (!before) mkdirSync(path, { recursive: true });
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory()) throw new Error(`Managed-skills directory is unsafe: ${path}`);
}

export async function readRegularFile(path: string, options: RegularFileReadOptions): Promise<string> {
  const pathStat = await lstat(path);
  assertRegularSingleLinkFile(options.label, pathStat, options.maxBytes);
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = await handle.stat();
    assertRegularSingleLinkFile(options.label, stat, options.maxBytes);
    const content = await handle.readFile("utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > options.maxBytes) throw new Error(`${options.label} is ${bytes} bytes; the limit is ${options.maxBytes}.`);
    return content;
  } finally {
    await handle.close();
  }
}

export function readRegularFileSync(path: string, options: RegularFileReadOptions): string {
  const pathStat = lstatSync(path);
  assertRegularSingleLinkFile(options.label, pathStat, options.maxBytes);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = fstatSync(fd);
    assertRegularSingleLinkFile(options.label, stat, options.maxBytes);
    const content = readFileSync(fd, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > options.maxBytes) throw new Error(`${options.label} is ${bytes} bytes; the limit is ${options.maxBytes}.`);
    return content;
  } finally {
    closeSync(fd);
  }
}

async function commitAtomicFile(path: string, content: string, options: AtomicWriteOptions, replace: boolean): Promise<void> {
  await ensureSafeDirectory(dirname(path));
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
      options.mode ?? 0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.(temporaryPath);
    if (replace) {
      await rename(temporaryPath, path);
    } else {
      await link(temporaryPath, path);
      await rm(temporaryPath);
    }
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteFile(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  await commitAtomicFile(path, content, options, true);
}

export async function atomicCreateFile(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  await commitAtomicFile(path, content, options, false);
}
