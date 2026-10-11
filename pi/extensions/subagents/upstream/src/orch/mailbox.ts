import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const LEGACY_QUEUE_TYPE = "pi-subagent:queue:v1";
const ACCEPTED_TYPE = "pi-subagent:mailbox:accepted:v2";
const CONSUMED_TYPE = "pi-subagent:mailbox:consumed:v2";
const MIGRATION_TYPE = "pi-subagent:mailbox:migration:v2";
export const MAILBOX_FIELD = "piSubagentMailbox";
export const BOOTSTRAP_MESSAGE = "Subagent session initialized; awaiting parent input.";

export type AcceptedKind = "steer" | "followUp" | "update";

export interface AcceptedLedgerEntry {
  id: string;
  kind: AcceptedKind;
  content: string;
  timestamp: number;
}

interface ConsumedLedgerEntry {
  id: string;
  messageEntryId: string;
}

interface LegacyQueueSnapshot {
  steering?: unknown;
  followUp?: unknown;
}

interface MigrationMarker {
  sourceEntryId: string;
}

interface MailboxMarker {
  id: string;
  kind: AcceptedKind | "bootstrap";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAcceptedEntry = (
  entry: SessionEntry,
): entry is SessionEntry & { data: AcceptedLedgerEntry } =>
  entry.type === "custom" &&
  entry.customType === ACCEPTED_TYPE &&
  isAcceptedLedgerEntry(entry.data);

const isConsumedEntry = (
  entry: SessionEntry,
): entry is SessionEntry & { data: ConsumedLedgerEntry } =>
  entry.type === "custom" &&
  entry.customType === CONSUMED_TYPE &&
  isConsumedLedgerEntry(entry.data);

const isMigrationEntry = (entry: SessionEntry, sourceEntryId: string): boolean =>
  entry.type === "custom" &&
  entry.customType === MIGRATION_TYPE &&
  isObject(entry.data) &&
  entry.data.sourceEntryId === sourceEntryId;

const isAcceptedKind = (value: unknown): value is AcceptedKind =>
  value === "steer" || value === "followUp" || value === "update";

const isAcceptedLedgerEntry = (value: unknown): value is AcceptedLedgerEntry =>
  isObject(value) &&
  typeof value.id === "string" &&
  isAcceptedKind(value.kind) &&
  typeof value.content === "string" &&
  typeof value.timestamp === "number";

const isConsumedLedgerEntry = (value: unknown): value is ConsumedLedgerEntry =>
  isObject(value) && typeof value.id === "string" && typeof value.messageEntryId === "string";

const getMailboxMarker = (value: unknown): MailboxMarker | undefined => {
  if (!isObject(value)) return undefined;
  const marker = value[MAILBOX_FIELD];
  if (!isObject(marker) || typeof marker.id !== "string") return undefined;
  if (
    marker.kind !== "steer" &&
    marker.kind !== "followUp" &&
    marker.kind !== "update" &&
    marker.kind !== "bootstrap"
  )
    return undefined;
  return { id: marker.id, kind: marker.kind };
};

const normalizeLegacyQueue = (
  value: unknown,
): { steering: string[]; followUp: string[] } | undefined => {
  if (!isObject(value)) return undefined;
  const steering = value.steering;
  const followUp = value.followUp;
  if (
    !Array.isArray(steering) ||
    !steering.every((text) => typeof text === "string") ||
    !Array.isArray(followUp) ||
    !followUp.every((text) => typeof text === "string")
  ) {
    return undefined;
  }
  return { steering: [...steering], followUp: [...followUp] };
};

const getAcceptedIdFromEntry = (entry: SessionEntry): string | undefined => {
  if (entry.type === "message" && entry.message.role === "user") {
    return getMailboxMarker(entry.message)?.id;
  }
  if (entry.type === "custom_message") {
    return getMailboxMarker(entry.details)?.id;
  }
  return undefined;
};

export const buildQueuedUserMessage = (entry: AcceptedLedgerEntry) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text: entry.content }],
  timestamp: entry.timestamp,
  [MAILBOX_FIELD]: { id: entry.id, kind: entry.kind },
});

export const buildUpdateDetails = (entry: AcceptedLedgerEntry) => ({
  [MAILBOX_FIELD]: { id: entry.id, kind: entry.kind },
});

export const buildBootstrapMessage = (timestamp = Date.now()) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text: BOOTSTRAP_MESSAGE }],
  timestamp,
  [MAILBOX_FIELD]: { id: `bootstrap:${timestamp}`, kind: "bootstrap" as const },
});

export class DurableMailbox {
  private readonly accepted = new Map<string, AcceptedLedgerEntry>();
  private readonly consumed = new Set<string>();
  private readonly enqueued = new Set<string>();

  constructor(private readonly sessionManager: SessionManager) {
    this.migrateLegacyQueue();
    this.restore();
  }

  accept(kind: AcceptedKind, content: string, timestamp = Date.now()): AcceptedLedgerEntry {
    return this.appendAccepted({ id: randomUUID(), kind, content, timestamp });
  }

  pending(): AcceptedLedgerEntry[] {
    return [...this.accepted.values()].filter((entry) => !this.consumed.has(entry.id));
  }

  replayablePending(): AcceptedLedgerEntry[] {
    return this.pending().filter((entry) => !this.enqueued.has(entry.id));
  }

  markEnqueued(id: string): void {
    this.enqueued.add(id);
  }

  clearQueuedInputs(): void {
    for (const entry of this.accepted.values()) {
      if (entry.kind === "steer" || entry.kind === "followUp") this.enqueued.delete(entry.id);
    }
  }

  private consumeAppended(messageEntryId: string, markerSource: unknown): void {
    const id = getMailboxMarker(markerSource)?.id;
    if (!id || !this.accepted.has(id) || this.consumed.has(id)) return;
    this.sessionManager.appendCustomEntry(CONSUMED_TYPE, { id, messageEntryId });
    this.consumed.add(id);
    this.enqueued.delete(id);
  }

  wrapAppends(onCheckpoint: () => void): () => void {
    const originalAppendMessage = this.sessionManager.appendMessage.bind(this.sessionManager);
    const originalAppendCustomMessageEntry = this.sessionManager.appendCustomMessageEntry.bind(
      this.sessionManager,
    );

    this.sessionManager.appendMessage = (message) => {
      const entryId = originalAppendMessage(message);
      this.consumeAppended(entryId, message);
      onCheckpoint();
      return entryId;
    };

    this.sessionManager.appendCustomMessageEntry = (customType, content, display, details) => {
      const entryId = originalAppendCustomMessageEntry(customType, content, display, details);
      this.consumeAppended(entryId, details);
      onCheckpoint();
      return entryId;
    };

    return () => {
      this.sessionManager.appendMessage = originalAppendMessage;
      this.sessionManager.appendCustomMessageEntry = originalAppendCustomMessageEntry;
    };
  }

  private appendAccepted(entry: AcceptedLedgerEntry): AcceptedLedgerEntry {
    this.sessionManager.appendCustomEntry(ACCEPTED_TYPE, entry);
    this.accepted.set(entry.id, entry);
    return entry;
  }

  private migrateLegacyQueue(): void {
    const branch = this.sessionManager.getBranch();
    const legacy = [...branch]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === LEGACY_QUEUE_TYPE);
    if (!legacy || branch.some((entry) => isMigrationEntry(entry, legacy.id))) return;
    const queue = normalizeLegacyQueue(
      (legacy as SessionEntry & { data?: LegacyQueueSnapshot }).data,
    );
    if (!queue) return;
    const existingIds = new Set<string>();
    for (const entry of branch) {
      if (isAcceptedEntry(entry) || isConsumedEntry(entry)) existingIds.add(entry.data.id);
      const acceptedId = getAcceptedIdFromEntry(entry);
      if (acceptedId) existingIds.add(acceptedId);
    }
    const appendLegacyAccepted = (kind: AcceptedKind, content: string, occurrenceIndex: number) => {
      const accepted = {
        id: `legacy:${legacy.id}:${kind}:${occurrenceIndex}`,
        kind,
        content,
        timestamp: Date.parse(legacy.timestamp),
      } satisfies AcceptedLedgerEntry;
      if (existingIds.has(accepted.id)) return;
      this.appendAccepted(accepted);
      existingIds.add(accepted.id);
    };
    queue.steering.forEach((content, occurrenceIndex) => {
      appendLegacyAccepted("steer", content, occurrenceIndex);
    });
    queue.followUp.forEach((content, occurrenceIndex) => {
      appendLegacyAccepted("followUp", content, occurrenceIndex);
    });
    this.sessionManager.appendCustomEntry(MIGRATION_TYPE, {
      sourceEntryId: legacy.id,
    } satisfies MigrationMarker);
  }

  private restore(): void {
    this.accepted.clear();
    this.consumed.clear();
    this.enqueued.clear();
    for (const entry of this.sessionManager.getBranch()) {
      if (isAcceptedEntry(entry)) {
        this.accepted.set(entry.data.id, entry.data);
        continue;
      }
      if (isConsumedEntry(entry)) {
        this.consumed.add(entry.data.id);
        continue;
      }
      const transcriptId = getAcceptedIdFromEntry(entry);
      if (transcriptId) this.consumed.add(transcriptId);
    }
  }
}

