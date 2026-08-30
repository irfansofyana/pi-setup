import { chmod, link, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class TimedCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(now: () => number, ttlMs: number, maxEntries: number) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
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

  async save(input: { url: string; title: string; content: string; provider: string }): Promise<ArtifactRecord> {
    await this.ensureRoot();
    const id = this.options.randomId();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("Artifact ID generator returned an unsafe value.");
    const createdAt = new Date(this.options.now()).toISOString();
    const expiresAt = new Date(this.options.now() + this.options.ttlMs).toISOString();
    const record: StoredArtifact = { id, ...input, createdAt, expiresAt };
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
  }

  async read(id: string): Promise<StoredArtifact | undefined> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.options.root, `${id}.json`), "utf8")) as StoredArtifact;
    } catch {
      return undefined;
    }
  }
}
