import assert from "node:assert/strict";
import test from "node:test";

import terminalStatusTitle, {
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
  basename,
  formatTitle,
  statusIndicator,
  truncateTitle,
} from "./index.ts";

test("title helpers use session name, cwd basename, and bounded title", () => {
  assert.equal(basename("/work/pi-setup/"), "pi-setup");
  assert.equal(basename("C:\\work\\pi-setup\\"), "pi-setup");
  assert.equal(basename("/"), DEFAULT_TITLE);
  assert.equal(truncateTitle("x".repeat(MAX_TITLE_LENGTH + 1)), `${"x".repeat(MAX_TITLE_LENGTH - 3)}...`);

  const pi = { getSessionName: () => "  title from session  " } as never;
  const ctx = { cwd: "/work/pi-setup", hasUI: true } as never;
  assert.equal(formatTitle(pi, ctx, "idle", 0), "○ | π | title from session");
  assert.equal(formatTitle({ getSessionName: () => "" } as never, ctx, "done", 0), "✓ | π | pi-setup");
});

test("status indicators include spinner, done, error, and idle", () => {
  assert.equal(statusIndicator("working", 0), "⠋");
  assert.equal(statusIndicator("working", 10), "⠋");
  assert.equal(statusIndicator("done", 0), "✓");
  assert.equal(statusIndicator("error", 0), "✗");
  assert.equal(statusIndicator("idle", 0), "○");
});

test("extension writes lifecycle title and clears timer on shutdown", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    getSessionName: () => "",
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers.set(event, handler);
    },
  } as never;
  const titles: string[] = [];
  const ctx = {
    cwd: "/work/pi-setup",
    hasUI: true,
    ui: { setTitle: (title: string) => titles.push(title) },
  } as never;

  terminalStatusTitle(pi);
  await handlers.get("session_start")!({}, ctx);
  await handlers.get("agent_start")!({}, ctx);
  await handlers.get("agent_settled")!({}, ctx);
  await handlers.get("session_shutdown")!({}, ctx);

  assert.deepEqual(titles.slice(-3), ["○ | π | pi-setup", "⠋ | π | pi-setup", "✓ | π | pi-setup"]);
});
