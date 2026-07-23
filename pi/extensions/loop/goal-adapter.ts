import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  GOAL_DRIVER_REQUEST_EVENT,
  GOAL_DRIVER_RESPONSE_PREFIX,
  type GoalDriverResponse,
} from "../goal-loop/driver.ts";
import type { LoopDriver, LoopDriverClaimInput, LoopExtensionOptions } from "./index.ts";

interface AdapterEventBus {
  on(event: string, handler: (value: unknown) => void): () => void;
  emit(event: string, value: unknown): void;
}

interface AdapterPi {
  events: AdapterEventBus;
}

function driverRequest(
  events: AdapterEventBus,
  action: "claim" | "release",
  input: LoopDriverClaimInput,
  timeoutMs = 2_000,
): Promise<GoalDriverResponse | undefined> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const responseEvent = `${GOAL_DRIVER_RESPONSE_PREFIX}${requestId}`;
    const finish = (value: GoalDriverResponse | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = events.on(responseEvent, (value) => {
      if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).ok !== "boolean") return;
      finish(value as GoalDriverResponse);
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
    events.emit(GOAL_DRIVER_REQUEST_EVENT, {
      requestId,
      action,
      owner: "loop",
      ...input,
    });
  });
}

export function createLoopGoalDriver(pi: AdapterPi): LoopDriver {
  return {
    async claim(input) {
      const response = await driverRequest(pi.events, "claim", input);
      if (!response) return { ok: false, reason: "Goal Loop coordination did not respond." };
      return response.ok ? { ok: true } : { ok: false, reason: response.reason };
    },
    async release(input) {
      await driverRequest(pi.events, "release", input);
    },
  };
}

export function createGoalLoopAdapter(pi: ExtensionAPI): LoopExtensionOptions {
  return { driver: createLoopGoalDriver(pi as unknown as AdapterPi) };
}
