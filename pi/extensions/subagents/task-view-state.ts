import { createHash } from "node:crypto";
import type { AgentSelection } from "./fleet-view.ts";
import type { TaskDelivery, TaskDeliveryMode } from "./task-controls.ts";
import { projectTaskMessages, type TaskMessage } from "./task-transcript.ts";
import type { ThreadService, ThreadView, TranscriptSnapshot } from "./upstream/src/types.ts";

type Selection = Required<AgentSelection>;
export type TaskReadingState = {
  identity: string | number; follow: boolean; scrollTop: number; anchor?: string;
  mode?: TaskDeliveryMode; delivery?: TaskDelivery; retryAllowed?: boolean;
};
type Entry = TaskReadingState & {
  latest: Map<string, string>; seen: Map<string, string>; observing: boolean;
  generation: number; revision: number; off?: () => void;
};
const fingerprints = (messages: readonly TaskMessage[]) => new Map(messages.filter(message => message.role === "Agent")
  .map(message => [message.key, createHash("sha256").update(`${message.offset}:${message.text}`).digest("hex")]));

/** Session-owned UI memory. Retains bounded text hashes, never raw snapshots or disk transcripts. */
export class TaskViewStore {
  private entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly changed: () => void = () => {}) {}
  get(selection: Selection): TaskReadingState { return this.entry(selection); }
  private entry(selection: Selection): Entry {
    let entry = this.entries.get(selection.path);
    if (entry?.identity !== selection.identity) {
      try { entry?.off?.(); } catch { /* Optional observer cleanup. */ }
      entry = { identity: selection.identity, follow: true, scrollTop: 0, latest: new Map(), seen: new Map(), observing: false, generation: -1, revision: -1 };
      this.entries.set(selection.path, entry);
    }
    return entry!;
  }
  unread(selection: Selection): number {
    const entry = this.entries.get(selection.path);
    if (!entry || entry.identity !== selection.identity) return 0;
    return [...entry.latest].filter(([key, value]) => entry.seen.get(key) !== value).length;
  }
  markSeen(selection: Selection, messages: readonly TaskMessage[]) {
    if (this.disposed) return;
    const entry = this.entry(selection), before = this.unread(selection);
    for (const [key, hash] of fingerprints(messages)) if (entry.latest.get(key) === hash) entry.seen.set(key, hash);
    if (before !== this.unread(selection)) this.changed();
  }
  receive(selection: Selection, snapshot: TranscriptSnapshot) {
    if (this.disposed) return;
    const entry = this.entry(selection);
    if (snapshot.generation < entry.generation || (snapshot.generation === entry.generation && snapshot.revision <= entry.revision)) return;
    const latest = fingerprints(projectTaskMessages(snapshot));
    entry.generation = snapshot.generation; entry.revision = snapshot.revision;
    const before = this.unread(selection);
    entry.latest = latest;
    for (const key of entry.seen.keys()) if (!entry.latest.has(key)) entry.seen.delete(key);
    if (before !== this.unread(selection)) this.changed();
  }
  reconcile(threads: readonly ThreadView[], service: ThreadService) {
    if (this.disposed) return;
    const live = new Map(threads.filter(thread => thread.path !== "/root").map(thread => [thread.path, thread.costId ?? thread.createdAt]));
    for (const [path, entry] of this.entries) if (live.get(path) !== entry.identity) {
      this.entries.delete(path); try { entry.off?.(); } catch { /* Continue cleanup. */ }
    }
    const observe = service.observeTranscript;
    if (!observe) return;
    for (const [path, identity] of live) {
      const selection = { path, identity }, entry = this.entry(selection);
      if (entry.observing) continue;
      entry.observing = true;
      const current = () => !this.disposed && this.entries.get(path) === entry;
      const accept = (snapshot: TranscriptSnapshot) => {
        if (!current() || (snapshot.thread && (snapshot.thread.path !== path || (snapshot.thread.costId ?? snapshot.thread.createdAt) !== identity))) return;
        try { this.receive(selection, snapshot); } catch { /* Unread UI cannot affect execution. */ }
      };
      void Promise.resolve().then(() => current() ? observe.call(service, path, accept) : undefined).then(observation => {
        if (!observation) return;
        if (!current()) { observation.unsubscribe(); return; }
        entry.off = observation.unsubscribe; accept(observation.snapshot);
      }).catch(() => { /* Keep the panel's explicit status fallback; avoid retry loops. */ });
    }
  }
  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) try { entry.off?.(); } catch { /* Continue cleanup. */ }
    this.entries.clear();
  }
}
