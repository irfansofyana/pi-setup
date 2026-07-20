export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TimerHandle {
  unref?: () => void;
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AbsoluteScheduler {
  private handle?: TimerHandle;
  private deadline?: number;
  private callback?: () => void;
  private readonly clock: SchedulerClock;

  constructor(clock: SchedulerClock = systemClock) {
    this.clock = clock;
  }

  arm(deadline: number, callback: () => void): void {
    this.cancel();
    this.deadline = deadline;
    this.callback = callback;
    this.armChunk();
  }

  cancel(): void {
    if (this.handle) this.clock.clearTimeout(this.handle);
    this.handle = undefined;
    this.deadline = undefined;
    this.callback = undefined;
  }

  isArmed(): boolean {
    return this.handle !== undefined;
  }

  armedDeadline(): number | undefined {
    return this.deadline;
  }

  private armChunk(): void {
    const deadline = this.deadline;
    const callback = this.callback;
    if (deadline === undefined || !callback) return;

    const remaining = deadline - this.clock.now();
    if (remaining <= 0) {
      this.handle = this.clock.setTimeout(() => this.fire(), 0);
    } else {
      this.handle = this.clock.setTimeout(
        () => remaining > MAX_TIMER_DELAY_MS ? this.armChunk() : this.fire(),
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
    }
    this.handle.unref?.();
  }

  private fire(): void {
    const callback = this.callback;
    this.handle = undefined;
    this.deadline = undefined;
    this.callback = undefined;
    callback?.();
  }
}
