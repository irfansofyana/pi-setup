import { watchFile, unwatchFile, type Stats } from "node:fs";

import type { LoopFileEvent } from "./state.ts";

export interface FileWakeService {
  watch(
    path: string,
    event: LoopFileEvent,
    onWake: (event: Exclude<LoopFileEvent, "any">) => void,
    onError: (error: Error) => void,
  ): () => void;
}

export function classifyFileEvent(current: Stats, previous: Stats): Exclude<LoopFileEvent, "any"> | undefined {
  const existed = previous.nlink > 0;
  const exists = current.nlink > 0;
  if (!existed && exists) return "create";
  if (existed && !exists) return "delete";
  if (
    existed &&
    exists &&
    (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs || current.size !== previous.size)
  ) return "change";
  return undefined;
}

export function createFileWakeService(intervalMs = 500): FileWakeService {
  return {
    watch(path, requestedEvent, onWake, onError) {
      let active = true;
      const listener = (current: Stats, previous: Stats) => {
        if (!active) return;
        try {
          const event = classifyFileEvent(current, previous);
          if (!event || (requestedEvent !== "any" && requestedEvent !== event)) return;
          active = false;
          unwatchFile(path, listener);
          onWake(event);
        } catch (error) {
          active = false;
          unwatchFile(path, listener);
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      try {
        watchFile(path, { persistent: false, interval: intervalMs }, listener);
      } catch (error) {
        active = false;
        throw error instanceof Error ? error : new Error(String(error));
      }
      return () => {
        if (!active) return;
        active = false;
        unwatchFile(path, listener);
      };
    },
  };
}
