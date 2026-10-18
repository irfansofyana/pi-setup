import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { defaultSleep } from "./transport.ts";

const transportUrl = new URL("./transport.ts", import.meta.url).href;

test("awaited retry sleep keeps a standalone process alive until settlement", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { defaultSleep } from ${JSON.stringify(transportUrl)};
    await defaultSleep(20);
    console.log("retry completed");
  `], { encoding: "utf8", timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retry completed/);
});

test("retry sleep rejects an already-aborted signal", async () => {
  await assert.rejects(defaultSleep(1000, AbortSignal.abort()), { name: "AbortError" });
});

test("retry sleep aborts promptly and removes its pending timer", async () => {
  const controller = new AbortController();
  const sleeping = defaultSleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(sleeping, { name: "AbortError" });
});
