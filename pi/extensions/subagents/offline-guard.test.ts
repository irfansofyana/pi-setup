import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const guard = fileURLToPath(new URL("./offline-network-guard.mjs", import.meta.url));
test("offline smoke guard rejects global fetch before any transport", () => {
  const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", "await fetch('https://example.test')"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline smoke: network forbidden/);
});
test("offline smoke guard rejects native TCP before connect", () => {
  const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", "import net from 'node:net'; net.connect(80, 'example.test')"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline smoke: network forbidden/);
});
