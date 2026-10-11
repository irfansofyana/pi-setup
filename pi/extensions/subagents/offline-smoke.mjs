#!/usr/bin/env node
// Isolated, user-invoked SDK feasibility smoke; never loads the package entrypoint.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const home = mkdtempSync(join(tmpdir(), "pi-subagents-smoke-home-"));
try {
  const result = spawnSync(process.execPath, ["--max-old-space-size=192", "--import", join(import.meta.dirname, "offline-network-guard.mjs"), "--test", "--test-concurrency=1", join(import.meta.dirname, "backend.test.ts"), join(import.meta.dirname, "trusted.test.ts")], {
    stdio: "inherit", env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, TMPDIR: process.env.TMPDIR ?? home,
      // No actual provider secrets are forwarded to the child.
      PI_CODING_AGENT_DIR: home }, timeout: 30000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
