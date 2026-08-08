import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TITLE = "π";
export const PREFIX = "π";
export const MAX_TITLE_LENGTH = 40;
export const SPINNER_INTERVAL_MS = 120;
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type TitleStatus = "idle" | "working" | "done" | "error";

export function truncateTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return title.slice(0, MAX_TITLE_LENGTH - 3) + "...";
}

export function basename(path: string | undefined): string {
  if (!path) return DEFAULT_TITLE;

  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return DEFAULT_TITLE;

  return trimmed.split(/[\\/]/).pop() || DEFAULT_TITLE;
}

export function getSessionName(pi: ExtensionAPI): string {
  const name = pi.getSessionName?.();
  return typeof name === "string" ? name.trim() : "";
}

export function getRawTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
  return getSessionName(pi) || basename(ctx.cwd);
}

export function isSpinningStatus(status: TitleStatus): boolean {
  return status === "working";
}

export function statusIndicator(status: TitleStatus, spinnerFrame: number): string {
  if (isSpinningStatus(status)) {
    if (SPINNER_FRAMES.length === 0) return "◉";
    return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
  }

  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "○";
}

export function formatTitle(pi: ExtensionAPI, ctx: ExtensionContext, status: TitleStatus, spinnerFrame: number): string {
  const rawTitle = getRawTitle(pi, ctx);
  const suffix = rawTitle === DEFAULT_TITLE ? DEFAULT_TITLE : `${PREFIX} | ${truncateTitle(rawTitle)}`;

  return `${statusIndicator(status, spinnerFrame)} | ${suffix}`;
}

export default function terminalStatusTitle(pi: ExtensionAPI) {
  let status: TitleStatus = "idle";
  let spinnerFrame = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let deferredWrite: ReturnType<typeof setTimeout> | undefined;
  let lastCtx: ExtensionContext | undefined;

  function clearDeferredWrite() {
    if (!deferredWrite) return;

    clearTimeout(deferredWrite);
    deferredWrite = undefined;
  }

  function writeTitle(ctx = lastCtx) {
    if (!ctx?.hasUI) return;

    lastCtx = ctx;
    ctx.ui.setTitle(formatTitle(pi, ctx, status, spinnerFrame));
  }

  function stopSpinner() {
    if (!spinnerInterval) return;

    clearInterval(spinnerInterval);
    spinnerInterval = undefined;
    spinnerFrame = 0;
  }

  function startSpinner(ctx: ExtensionContext) {
    if (!ctx.hasUI || spinnerInterval) return;

    spinnerFrame = 0;
    spinnerInterval = setInterval(() => {
      if (!isSpinningStatus(status)) {
        stopSpinner();
        return;
      }

      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      writeTitle();
    }, SPINNER_INTERVAL_MS);
    spinnerInterval.unref?.();
  }

  function setStatus(nextStatus: TitleStatus, ctx: ExtensionContext) {
    clearDeferredWrite();
    status = nextStatus;
    lastCtx = ctx;

    if (isSpinningStatus(status)) {
      startSpinner(ctx);
    } else {
      stopSpinner();
    }

    writeTitle(ctx);
  }

  function scheduleWrite(ctx: ExtensionContext) {
    clearDeferredWrite();
    deferredWrite = setTimeout(() => {
      deferredWrite = undefined;
      writeTitle(ctx);
    }, 0);
    deferredWrite.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    setStatus("idle", ctx);
    scheduleWrite(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    scheduleWrite(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    setStatus("working", ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    setStatus("done", ctx);
  });

  pi.on("session_shutdown", async () => {
    clearDeferredWrite();
    stopSpinner();
  });
}
