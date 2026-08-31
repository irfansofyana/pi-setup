import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class TimedCache<T> {
  private readonly entries = new Map<string, { value: T; createdAt: number; expiresAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(now: () => number, ttlMs: number, maxEntries: number) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    return this.getWithAge(key)?.value;
  }

  getWithAge(key: string): { value: T; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, ageMs: Math.max(0, this.now() - entry.createdAt) };
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    const createdAt = this.now();
    this.entries.set(key, { value, createdAt, expiresAt: createdAt + this.ttlMs });
  }
}

export interface ArtifactRecord {
  id: string;
  path: string;
  url: string;
  chars: number;
  createdAt: string;
  expiresAt: string;
}

export interface ArtifactStoreOptions {
  root: string;
  now: () => number;
  randomId: () => string;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

interface StoredArtifact {
  id: string;
  url: string;
  title: string;
  content: string;
  provider: string;
  contextKey: string;
  createdAt: string;
  expiresAt: string;
}

export class ArtifactStore {
  private readonly options: ArtifactStoreOptions;

  constructor(options: ArtifactStoreOptions) {
    this.options = options;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Web research artifact root must be a real directory.");
    await chmod(this.options.root, 0o700);
  }

  private async withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    const lockPath = join(this.options.root, ".capacity.lock");
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 30_000) {
            await rmdir(lockPath);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for web research artifact capacity lock.");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      try { await rmdir(lockPath); } catch { /* stale-lock recovery handles abnormal removal */ }
    }
  }

  private async cleanup(additionalEntries = 0, additionalBytes = 0): Promise<void> {
    const names = (await readdir(this.options.root)).filter((name) => name.endsWith(".json"));
    const rows: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(this.options.root, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        if (info.mtimeMs + this.options.ttlMs <= this.options.now()) {
          await unlink(path);
          continue;
        }
        rows.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A concurrent cleanup or missing artifact is harmless.
      }
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    let bytes = additionalBytes;
    const existingEntryLimit = Math.max(0, this.options.maxEntries - additionalEntries);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (index >= existingEntryLimit || bytes + row.size > this.options.maxBytes) {
        try { await unlink(row.path); } catch { /* already removed */ }
      } else {
        bytes += row.size;
      }
    }
  }

  async save(input: { url: string; title: string; content: string; provider: string; context?: Record<string, unknown> }): Promise<ArtifactRecord> {
    return this.withCapacityLock(async () => {
      const id = this.options.randomId();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("Artifact ID generator returned an unsafe value.");
      const createdAt = new Date(this.options.now()).toISOString();
      const expiresAt = new Date(this.options.now() + this.options.ttlMs).toISOString();
      const contextKey = createHash("sha256")
        .update(JSON.stringify({ url: input.url, provider: input.provider, ...(input.context ?? {}) }))
        .digest("hex");
      const { context: _context, ...storedInput } = input;
      const record: StoredArtifact = { id, ...storedInput, contextKey, createdAt, expiresAt };
      const data = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(data) > this.options.maxBytes) throw new Error("Fetched content exceeds the artifact store byte limit.");
      await this.cleanup(1, Buffer.byteLength(data));
      const target = join(this.options.root, `${id}.json`);
      const temporary = join(this.options.root, `.${id}.${process.pid}.tmp`);
      try {
        await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await chmod(temporary, 0o600);
        await link(temporary, target);
        await unlink(temporary);
        await chmod(target, 0o600);
      } catch (error) {
        try { await unlink(temporary); } catch { /* nothing to clean */ }
        throw error;
      }
      return { id, path: target, url: input.url, chars: input.content.length, createdAt, expiresAt };
    });
  }

  async read(id: string, offset: number, maxCharacters: number): Promise<{
    id: string;
    url: string;
    title: string;
    provider: string;
    contextKey: string;
    content: string;
    offset: number;
    nextOffset: number;
    hasMore: boolean;
  }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("Unsafe artifact ID.");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Artifact offset must be a non-negative integer.");
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 12_000) {
      throw new Error("Artifact maxCharacters must be an integer between 1 and 12000.");
    }
    await this.ensureRoot();
    const path = join(this.options.root, `${id}.json`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > this.options.maxBytes) throw new Error("Artifact is not a safe regular file.");
    const record = JSON.parse(await readFile(path, "utf8")) as Partial<StoredArtifact>;
    if (record.id !== id || typeof record.content !== "string" || typeof record.expiresAt !== "string") {
      throw new Error("Artifact record is invalid.");
    }
    if (Date.parse(record.expiresAt) <= this.options.now()) {
      try { await unlink(path); } catch { /* already removed */ }
      throw new Error("Artifact has expired.");
    }
    if (typeof record.url !== "string" || typeof record.title !== "string" || typeof record.provider !== "string" || typeof record.contextKey !== "string") {
      throw new Error("Artifact metadata is invalid.");
    }
    const content = record.content.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length;
    return {
      id,
      url: record.url,
      title: record.title,
      provider: record.provider,
      contextKey: record.contextKey,
      content,
      offset,
      nextOffset,
      hasMore: nextOffset < record.content.length,
    };
  }
}
