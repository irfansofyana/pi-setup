import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeHindsightScope,
  projectKey,
  readHindsightRetainConfig,
  redactSecrets,
  retainHindsightLesson,
  sanitizeLearnText,
} from "./hindsight.ts";

test("lesson sanitization redacts secrets and enforces limits", () => {
  assert.equal(redactSecrets("token=supersecretvalue"), "[REDACTED]");
  assert.equal(sanitizeLearnText(" keep\nthis\tlesson "), "keep this lesson");
  assert.throws(() => sanitizeLearnText("", 10), /empty/);
  assert.throws(() => sanitizeLearnText("too long", 3), /limit is 3/);
});

test("Hindsight scoping supports global and project modes", () => {
  const key = projectKey("/tmp/example");
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "global" }, "/tmp/example"), { bankId: "coding-agent" });
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "per-project" }, "/tmp/example"), { bankId: `coding-agent-${key}` });
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "per-project-tagged" }, "/tmp/example"), {
    bankId: "coding-agent",
    tags: [`project:${key}`],
    tagsMatch: "any",
  });
});

test("Hindsight retain config preserves zero timeouts from file and env", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-skills-hindsight-"));
  const configPath = join(root, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({ requestTimeoutMs: 0 }));
    assert.equal(readHindsightRetainConfig({ HINDSIGHT_CONFIG_PATH: configPath }).requestTimeoutMs, 0);
    assert.equal(readHindsightRetainConfig({
      HINDSIGHT_CONFIG_PATH: join(root, "missing.json"),
      HINDSIGHT_REQUEST_TIMEOUT_MS: "0",
    }).requestTimeoutMs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hindsight retain config rejects blank and negative timeouts", () => {
  const missingConfig = join(tmpdir(), "missing-managed-skills-hindsight-config.json");
  assert.equal(readHindsightRetainConfig({
    HINDSIGHT_CONFIG_PATH: missingConfig,
    HINDSIGHT_REQUEST_TIMEOUT_MS: "",
  }).requestTimeoutMs, 30_000);
  assert.equal(readHindsightRetainConfig({
    HINDSIGHT_CONFIG_PATH: missingConfig,
    HINDSIGHT_REQUEST_TIMEOUT_MS: "-1",
  }).requestTimeoutMs, 30_000);
});

test("retain posts an encoded, authorized, redacted Hindsight payload", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response("{}", { status: 200 });
  };

  const retained = await retainHindsightLesson({
    cwd: "/tmp/example",
    memory: "API_KEY=supersecretvalue and durable lesson",
    context: "Bearer abcdefghijklmnop",
    config: {
      apiUrl: "http://127.0.0.1:9999/",
      apiToken: "secret-token",
      bankId: "bank/name",
      scoping: "global",
      requestTimeoutMs: 1000,
    },
    fetchImpl: fetchImpl as typeof fetch,
  });

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(capturedUrl, "http://127.0.0.1:9999/v1/default/banks/bank%2Fname/memories");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.equal(body.items[0].content, "[REDACTED] and durable lesson");
  assert.equal(body.items[0].context, "[REDACTED]");
  assert.equal(body.items[0].metadata.source, "managed-skills-learn");
  assert.equal(body.async, true);
  assert.equal(retained.bankId, "bank/name");
});

test("retain reports non-success Hindsight responses", async () => {
  await assert.rejects(() => retainHindsightLesson({
    cwd: "/tmp/example",
    memory: "durable lesson",
    config: {
      apiUrl: "http://127.0.0.1:9999",
      bankId: "coding-agent",
      scoping: "global",
      requestTimeoutMs: 1000,
    },
    fetchImpl: (async () => new Response("offline", { status: 503 })) as typeof fetch,
  }), /Hindsight retain failed \(503\): offline/);
});
