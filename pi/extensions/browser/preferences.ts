import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BrowserLifecycleError } from "./controller.ts";

const MAX_BYTES = 64 * 1024;

/** Raw text/unknown keys are private mutation receipts, never tool output. */
export interface PreferenceSnapshot {
  exists: boolean;
  enabled: boolean;
  raw?: string;
  data: Record<string, unknown>;
  mode: number;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserLifecycleError("Browser preference change cancelled by lifecycle change.");
}

function sameSnapshot(a: PreferenceSnapshot, b: PreferenceSnapshot): boolean {
  return a.exists === b.exists && a.raw === b.raw && a.mode === b.mode;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Global opt-in only. No project overrides, credentials, profile data or MCP definitions. */
export class BrowserPreferences {
  readonly directory: string;
  readonly path: string;

  constructor(agentDir: string) {
    this.directory = join(agentDir, "browser");
    this.path = join(this.directory, "config.json");
  }

  async read(): Promise<PreferenceSnapshot> {
    try {
      try {
        const directory = await lstat(this.directory);
        if (directory.isSymbolicLink() || !directory.isDirectory()) throw new BrowserLifecycleError("Browser preferences directory must be a real directory; review it manually.");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw new BrowserLifecycleError("Browser preferences must be a regular JSON file no larger than 64 KiB; automatic access is blocked.");
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new BrowserLifecycleError("Browser preferences exceed 64 KiB; automatic access is blocked.");
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new BrowserLifecycleError("Browser preferences are invalid JSON; automatic access is blocked. Preserve the file and review it manually."); }
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new BrowserLifecycleError("Browser preferences must be a JSON object; automatic access is blocked.");
      const values = data as Record<string, unknown>;
      if ((values.schemaVersion !== undefined && values.schemaVersion !== 1) || (values.enabled !== undefined && typeof values.enabled !== "boolean")) throw new BrowserLifecycleError("Unsupported browser preference schema or enabled value; automatic access is blocked.");
      return { exists: true, enabled: values.enabled === true, raw, data: values, mode: stat.mode & 0o777 };
    } catch (error) {
      if (missing(error)) return { exists: false, enabled: false, data: {}, mode: 0o600 };
      if (error instanceof BrowserLifecycleError) throw error;
      throw new BrowserLifecycleError("Cannot read browser preferences; automatic access is blocked. Review the global browser/config.json privately.");
    }
  }

  /** Compare-and-save under an exclusive process-shared lock; never reclaim uncertain locks. */
  async setEnabled(expected: PreferenceSnapshot, enabled: boolean, signal?: AbortSignal): Promise<{ snapshot: PreferenceSnapshot; backup?: string }> {
    cancelled(signal);
    let locked = false;
    let temporary: string | undefined;
    const lock = join(this.directory, ".config.lock");
    try {
      const current = await this.read();
      if (!sameSnapshot(expected, current)) throw new BrowserLifecycleError("Browser preferences changed since review; no changes made. Re-read and retry.");
      if (current.enabled === enabled) return { snapshot: current };
      cancelled(signal);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Re-read after mkdir to reject replaced/symlinked feature directories.
      await this.read();
      try { await mkdir(lock, { mode: 0o700 }); locked = true; } catch {
        throw new BrowserLifecycleError("Browser preferences are busy or locked. Retry after other Pi sessions finish; do not remove an uncertain lock automatically.");
      }
      const latest = await this.read();
      if (!sameSnapshot(expected, latest)) throw new BrowserLifecycleError("Browser preferences changed since review; no changes made. Re-read and retry.");
      cancelled(signal);
      let backup: string | undefined;
      if (latest.exists) {
        const backupDirectory = join(this.directory, "backups");
        await mkdir(backupDirectory, { mode: 0o700 }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        const stat = await lstat(backupDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BrowserLifecycleError("Browser preference backup directory is unsafe; no changes made.");
        backup = join(backupDirectory, `config-${Date.now()}-${randomUUID()}.json`);
        const file = await open(backup, "wx", 0o600);
        try { await file.writeFile(latest.raw!, "utf8"); await file.sync(); } finally { await file.close(); }
      }
      const data = { ...latest.data, schemaVersion: 1, enabled };
      const raw = `${JSON.stringify(data, null, 2)}\n`;
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new BrowserLifecycleError("Updated browser preferences would exceed 64 KiB; no changes made.");
      temporary = join(this.directory, `.config-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(raw, "utf8");
        await file.chmod(latest.mode);
        await file.sync();
      } finally { await file.close(); }
      const beforeCommit = await this.read();
      if (!sameSnapshot(expected, beforeCommit)) throw new BrowserLifecycleError("Browser preferences changed before commit; no changes made. Re-read and retry.");
      cancelled(signal);
      await rename(temporary, this.path);
      temporary = undefined;
      return { snapshot: { exists: true, enabled, raw, data, mode: latest.mode }, backup };
    } catch (error) {
      if (error instanceof BrowserLifecycleError) throw error;
      throw new BrowserLifecycleError("Cannot save browser preferences; no successful preference change was confirmed. Review the global browser/config.json privately.");
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      if (locked) await rmdir(lock).catch(() => {});
    }
  }
}
