import test from "node:test";
import assert from "node:assert/strict";
import { TaskViewStore } from "./task-view-state.ts";
import type { ThreadView, TranscriptListener, TranscriptSnapshot } from "./upstream/src/types.ts";
import { projectTaskMessages } from "./task-transcript.ts";
const thread: ThreadView = { path: "/root/a", costId: "life", state: "running", type: "scout", task: "read", status: "", createdAt: 1, updatedAt: 1, parent: "/root", owner: "/root" };
const snapshot = (text: string, revision = 1): TranscriptSnapshot => ({ generation: 1, revision, inheritedCount: 0, tools: [], assistant: null,
  messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text }] }] as any });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("unread tracks changed agent text, not repeated snapshots or tool-only updates", async () => {
  let listener!: TranscriptListener;
  const store = new TaskViewStore();
  const service: any = { observeTranscript: async (_path: string, accept: TranscriptListener) => {
    listener = accept; return { snapshot: snapshot("first"), unsubscribe() {} };
  } };
  try {
    store.reconcile([thread], service); await flush();
    const selection = { path: thread.path, identity: "life" };
    assert.equal(store.unread(selection), 1);
    store.markSeen(selection, projectTaskMessages(snapshot("first")));
    listener(snapshot("first", 2)); assert.equal(store.unread(selection), 0);
    listener(snapshot("first and more", 3)); assert.equal(store.unread(selection), 1);
    store.markSeen(selection, projectTaskMessages(snapshot("first")));
    assert.equal(store.unread(selection), 1, "an older panel frame cannot acknowledge newer text");
    listener(snapshot("stale", 2)); assert.equal(store.unread(selection), 1);
  } finally { store.dispose(); }
});

test("reading state is per lifetime and late observations detach after session disposal", async () => {
  const store = new TaskViewStore(); let resolve!: (value: any) => void, detached = 0;
  const first = { path: thread.path, identity: "life" };
  store.get(first).follow = false; store.get(first).anchor = "message:10";
  assert.equal(store.get(first).anchor, "message:10");
  assert.equal(store.get({ ...first, identity: "replacement" }).follow, true);
  store.reconcile([thread], { observeTranscript: () => new Promise(yes => { resolve = yes; }) } as any);
  await flush(); store.dispose();
  resolve({ snapshot: snapshot("late"), unsubscribe() { detached++; } }); await flush();
  assert.equal(detached, 1);
});

test("reconcile owns one observer per lifetime and rejects callbacks after replacement", async () => {
  const store = new TaskViewStore(); const listeners: TranscriptListener[] = []; let detached = 0;
  const service: any = { observeTranscript: async (_: string, listener: TranscriptListener) => {
    listeners.push(listener); return { snapshot: snapshot("first"), unsubscribe() { detached++; } };
  } };
  try {
    store.reconcile([thread], service); store.reconcile([thread], service); await flush();
    assert.equal(listeners.length, 1);
    const replacement = { ...thread, costId: "replacement" };
    store.reconcile([replacement], service); await flush(); assert.equal(detached, 1);
    const selection = { path: thread.path, identity: "replacement" };
    store.markSeen(selection, projectTaskMessages(snapshot("first")));
    listeners[0](snapshot("late old data", 10)); assert.equal(store.unread(selection), 0);
    store.reconcile([], service); assert.equal(detached, 2);
  } finally { store.dispose(); }
  assert.equal(detached, 2);
});
