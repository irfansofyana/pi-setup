import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function canonicalPath(value: string, caller = "/root"): string {
  if (!value || value !== value.trim())
    throw new Error("Agent path must not be empty or contain surrounding whitespace");
  const path = value.startsWith("/") ? value : `${caller}/${value}`;
  const parts = path.slice(1).split("/");
  if (!parts.every((part) => SEGMENT.test(part)) || parts.length > 32) {
    throw new Error(
      "Agent paths require slash-separated names (letters, digits, - or _); no dot segments, escapes, empty segments or trailing slash",
    );
  }
  return path;
}
export function parentPath(path: string): string | null {
  canonicalPath(path);
  const last = path.lastIndexOf("/");
  return last === 0 ? null : path.slice(0, last);
}
export function isDescendant(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

/** Snapshot conversation, not the parent's prompt/loadout; retain only matched tool exchanges. */
export function inheritContext(messages: readonly AgentMessage[]): AgentMessage[] {
  const copy = structuredClone(messages);
  const matchedCalls = new Set<string>();
  const matchedResults = new Set<number>();
  const pending = new Map<string, { messageIndex: number; blockIndex: number }[]>();

  for (const [messageIndex, message] of copy.entries()) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== "toolCall") continue;
        const queue = pending.get(block.id);
        const occurrence = { messageIndex, blockIndex };
        if (queue) queue.push(occurrence);
        else pending.set(block.id, [occurrence]);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const queue = pending.get(message.toolCallId);
    const occurrence = queue?.shift();
    if (!occurrence) continue;
    matchedCalls.add(`${occurrence.messageIndex}:${occurrence.blockIndex}`);
    matchedResults.add(messageIndex);
    if (queue && !queue.length) pending.delete(message.toolCallId);
  }

  return copy.flatMap((message, messageIndex): AgentMessage[] => {
    // Only the system prompt/loadout is replaced; custom and shell messages are real conversation context.
    if (message.role === "system") return [];
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") return [];
      message.content = message.content.filter(
        (block, blockIndex) =>
          block.type !== "toolCall" || matchedCalls.has(`${messageIndex}:${blockIndex}`),
      );
      if (!message.content.length) return [];
      // A tools-only assistant without remaining calls should not claim a toolUse stop.
      if (
        message.stopReason === "toolUse" &&
        !message.content.some((block) => block.type === "toolCall")
      )
        message.stopReason = "stop";
    }
    if (message.role === "toolResult" && !matchedResults.has(messageIndex)) return [];
    return [message];
  });
}

