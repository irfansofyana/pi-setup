import assert from "node:assert/strict";
import test from "node:test";

import { AbsoluteScheduler, MAX_TIMER_DELAY_MS, type SchedulerClock, type TimerHandle } from "./scheduler.ts";

interface PendingTimer extends TimerHandle {
  id: number;
  at: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeClock implements SchedulerClock {
  time = 0;
  nextId = 1;
  timers: PendingTimer[] = [];
  delays: number[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): PendingTimer {
    const timer = { id: this.nextId++, at: this.time + delayMs, callback, cancelled: false };
    this.timers.push(timer);
    this.delays.push(delayMs);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    (handle as PendingTimer).cancelled = true;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const timer = this.timers
        .filter((entry) => !entry.cancelled && entry.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!timer) break;
      timer.cancelled = true;
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

test("AbsoluteScheduler fires once at absolute deadline", () => {
  const clock = new FakeClock();
  const scheduler = new AbsoluteScheduler(clock);
  let fires = 0;
  scheduler.arm(1_000, () => fires++);
  clock.advance(999);
  assert.equal(fires, 0);
  clock.advance(1);
  assert.equal(fires, 1);
  clock.advance(5_000);
  assert.equal(fires, 1);
  assert.equal(scheduler.isArmed(), false);
});

test("rearming and cancellation invalidate old callbacks", () => {
  const clock = new FakeClock();
  const scheduler = new AbsoluteScheduler(clock);
  const fired: string[] = [];
  scheduler.arm(1_000, () => fired.push("old"));
  scheduler.arm(2_000, () => fired.push("new"));
  clock.advance(2_000);
  assert.deepEqual(fired, ["new"]);
  scheduler.arm(3_000, () => fired.push("cancelled"));
  scheduler.cancel();
  clock.advance(2_000);
  assert.deepEqual(fired, ["new"]);
});

test("long deadlines rearm in bounded chunks", () => {
  const clock = new FakeClock();
  const scheduler = new AbsoluteScheduler(clock);
  let fired = false;
  const deadline = MAX_TIMER_DELAY_MS + 5_000;
  scheduler.arm(deadline, () => { fired = true; });
  assert.equal(clock.delays[0], MAX_TIMER_DELAY_MS);
  clock.advance(MAX_TIMER_DELAY_MS);
  assert.equal(fired, false);
  assert.equal(clock.delays.at(-1), 5_000);
  clock.advance(5_000);
  assert.equal(fired, true);
});
