import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Stable per-record parsing ceiling. Aggregate capacity is configurable and
// may shrink across upgrades, but must not make older expired records unreadable.
const MAX_STORED_ARTIFACT_BYTES = 4 * 1024 * 1024;

export class TimedCache<T> {
  private readonly entries = new Map<string, {
    value: T;
    createdAt: number;
    expiresAt: number;
    wallCreatedAt: number;
    wallExpiresAt: number;
  }>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxExpiryRecheckMs: number;

  constructor(
    now: () => number,
    ttlMs: number,
    maxEntries: number,
    wallNow: () => number = now,
    maxExpiryRecheckMs = 1_000,
  ) {
    this.now = now;
    this.wallNow = wallNow;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxExpiryRecheckMs = Math.max(1, maxExpiryRecheckMs);
  }

  private sweepExpired(): void {
    const now = this.now();
    const wallNow = this.wallNow();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now || entry.wallExpiresAt <= wallNow) this.entries.delete(key);
    }
  }

  private scheduleExpirySweep(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.entries.size === 0) return;
    const earliest = Math.min(...[...this.entries.values()].map((entry) => entry.expiresAt));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.sweepExpired();
      this.scheduleExpirySweep();
    }, Math.min(this.maxExpiryRecheckMs, Math.max(0, earliest - this.now())));
    this.expiryTimer.unref?.();
  }

  get(key: string): T | undefined {
    return this.getWithAge(key)?.value;
  }

  getWithAge(key: string): { value: T; ageMs: number } | undefined {
    this.sweepExpired();
    const entry = this.entries.get(key);
    if (!entry) {
      this.scheduleExpirySweep();
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.scheduleExpirySweep();
    return {
      value: entry.value,
      ageMs: Math.max(0, this.now() - entry.createdAt, this.wallNow() - entry.wallCreatedAt),
    };
  }

  set(key: string, value: T): void {
    this.sweepExpired();
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    const createdAt = this.now();
    const wallCreatedAt = this.wallNow();
    this.entries.set(key, {
      value,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      wallCreatedAt,
      wallExpiresAt: wallCreatedAt + this.ttlMs,
    });
    this.scheduleExpirySweep();
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
  lockTimeoutMs?: number;
  monotonicNow?: () => number;
}

interface StoredArtifact {
  id: string;
  url: string;
  canonicalUrl: string;
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

  private static throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Artifact operation cancelled.");
  }

  private async withCapacityLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.ensureRoot();
    const monotonicNow = this.options.monotonicNow ?? (() => performance.now());
    const deadline = monotonicNow() + (this.options.lockTimeoutMs ?? 5_000);
    const lockPath = join(this.options.root, ".capacity.lock");
    let lockIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    while (!lockIdentity) {
      ArtifactStore.throwIfAborted(signal);
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const info = await lstat(lockPath, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Web research artifact capacity lock must be a real directory.");
        lockIdentity = { dev: info.dev, ino: info.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (lockIdentity) break;
      if (monotonicNow() >= deadline) throw new Error("Timed out waiting for web research artifact capacity lock.");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("Artifact operation cancelled.")); };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, 10);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      ArtifactStore.throwIfAborted(signal);
      return await operation();
    } finally {
      try {
        const current = await lstat(lockPath, { bigint: true });
        if (current.isDirectory() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          await rm(lockPath, { recursive: true });
        }
      } catch { /* fail closed if the owned lock cannot be verified or removed */ }
    }
  }

  private async loadStoredArtifact(path: string, expectedId: string): Promise<StoredArtifact> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STORED_ARTIFACT_BYTES) {
      throw new Error("Artifact is not a safe regular file.");
    }
    let record: Partial<StoredArtifact>;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as Partial<StoredArtifact>;
    } catch {
      throw new Error("Artifact record is invalid.");
    }
    if (record.id !== expectedId || typeof record.content !== "string" || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))) {
      throw new Error("Artifact record is invalid.");
    }
    if (typeof record.url !== "string" || (record.canonicalUrl !== undefined && typeof record.canonicalUrl !== "string") || typeof record.title !== "string" || (record.provider !== "tavily" && record.provider !== "exa") || typeof record.contextKey !== "string") {
      throw new Error("Artifact metadata is invalid.");
    }
    return { ...record, canonicalUrl: record.canonicalUrl ?? record.url } as StoredArtifact;
  }

  private async cleanup(additionalEntries = 0, additionalBytes = 0): Promise<void> {
    const names = await readdir(this.options.root);
    for (const name of names.filter((candidate) => candidate.endsWith(".tmp"))) {
      const path = join(this.options.root, name);
      try { await rm(path, { recursive: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let entries = additionalEntries;
    let bytes = additionalBytes;
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const path = join(this.options.root, name);
      try {
        const record = await this.loadStoredArtifact(path, name.slice(0, -5));
        if (Date.parse(record.expiresAt) <= this.options.now()) {
          try { await unlink(path); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          continue;
        }
        entries++;
        bytes += (await lstat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (entries > this.options.maxEntries || bytes > this.options.maxBytes) {
      throw new Error("Web research artifact capacity is full; valid artifacts are preserved until they expire or are discarded.");
    }
  }

  async save(input: { url: string; canonicalUrl?: string; title: string; content: string; provider: string; context?: Record<string, unknown> }, signal?: AbortSignal): Promise<ArtifactRecord> {
    let publishedTarget: string | undefined;
    const compensate = async () => {
      if (!publishedTarget) return;
      try { await unlink(publishedTarget); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        publishedTarget = undefined;
      }
    };
    return this.withCapacityLock(async () => {
      ArtifactStore.throwIfAborted(signal);
      const id = this.options.randomId();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error("Artifact ID generator returned an unsafe value.");
      const createdAt = new Date(this.options.now()).toISOString();
      const expiresAt = new Date(this.options.now() + this.options.ttlMs).toISOString();
      const contextKey = createHash("sha256")
        .update(JSON.stringify({ url: input.url, provider: input.provider, ...(input.context ?? {}) }))
        .digest("hex");
      const { context: _context, ...storedInput } = input;
      const record: StoredArtifact = { id, ...storedInput, canonicalUrl: input.canonicalUrl ?? input.url, contextKey, createdAt, expiresAt };
      const data = `${JSON.stringify(record)}\n`;
      const dataBytes = Buffer.byteLength(data);
      if (dataBytes > Math.min(this.options.maxBytes, MAX_STORED_ARTIFACT_BYTES)) throw new Error("Fetched content exceeds the artifact store byte limit.");
      await this.cleanup(1, dataBytes);
      ArtifactStore.throwIfAborted(signal);
      const target = join(this.options.root, `${id}.json`);
      const temporary = join(this.options.root, `.${id}.${process.pid}.tmp`);
      try {
        await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await chmod(temporary, 0o600);
        ArtifactStore.throwIfAborted(signal);
        await link(temporary, target);
        publishedTarget = target;
        if (signal?.aborted) {
          await compensate();
          throw new Error("Artifact operation cancelled.");
        }
        await unlink(temporary);
        await chmod(target, 0o600);
        if (signal?.aborted) {
          await compensate();
          throw new Error("Artifact operation cancelled.");
        }
      } catch (error) {
        try { await unlink(temporary); } catch { /* nothing to clean */ }
        await compensate();
        throw error;
      }
      return { id, path: target, url: input.url, chars: input.content.length, createdAt, expiresAt };
    }, signal);
  }

  async discard(id: string): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) return;
    try { await unlink(join(this.options.root, `${id}.json`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async read(id: string, offset: number, maxCharacters: number): Promise<{
    id: string;
    url: string;
    canonicalUrl: string;
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
    const record = await this.loadStoredArtifact(path, id);
    if (Date.parse(record.expiresAt) <= this.options.now()) {
      try { await unlink(path); } catch { /* already removed */ }
      throw new Error("Artifact has expired.");
    }
    const content = record.content.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length;
    return {
      id,
      url: record.url,
      canonicalUrl: record.canonicalUrl ?? record.url,
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
