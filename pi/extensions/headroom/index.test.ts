import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  buildMarker,
  formatCount,
  initialStats,
  normalizeHeadroomConfig,
  outputLooksSensitive,
  retrieveWithQuery,
  savingsPercent,
  shouldCompressToolResult,
  statusText,
  truncateText,
} from "./index.ts";

test("normalizeHeadroomConfig uses Headroom-like defaults", () => {
  assert.deepEqual(normalizeHeadroomConfig({}), DEFAULT_CONFIG);
  assert.equal(normalizeHeadroomConfig({ minChars: 10 }).minChars, 10);
  assert.equal(normalizeHeadroomConfig({ minChars: -1 }).minChars, 1);
  assert.equal(normalizeHeadroomConfig({ startup: "auto" }).startup, "auto");
  assert.equal(normalizeHeadroomConfig({ notifyFailures: "always" }).notifyFailures, "always");
});

test("shouldCompressToolResult compresses all large non-excluded text", () => {
  const text = "x".repeat(DEFAULT_CONFIG.minChars);
  assert.equal(shouldCompressToolResult("bash", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("mcp", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("some_new_web_fetch_tool", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("write", {}, text, DEFAULT_CONFIG), false);
  assert.equal(shouldCompressToolResult("bash", {}, "small", DEFAULT_CONFIG), false);
});

test("secret-looking args or output bypass compression", () => {
  const text = "x".repeat(DEFAULT_CONFIG.minChars);
  assert.equal(shouldCompressToolResult("read", { path: ".env" }, text, DEFAULT_CONFIG), false);
  assert.equal(outputLooksSensitive("Authorization: Bearer abc.def.ghi"), true);
  assert.equal(outputLooksSensitive("normal build log"), false);
  assert.equal(shouldCompressToolResult("bash", {}, "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz", DEFAULT_CONFIG), false);
});

test("retrieveWithQuery returns focused matching lines", () => {
  const content = ["alpha", "before", "fatal auth error", "after", "omega"].join("\n");
  assert.match(retrieveWithQuery(content, "auth", 1, 10_000), /2: before/);
  assert.match(retrieveWithQuery(content, "auth", 1, 10_000), /3: fatal auth error/);
  assert.match(retrieveWithQuery(content, "missing", 1, 10_000), /no matches/);
});

test("truncateText caps retrieval bytes", () => {
  const result = truncateText("a".repeat(2000), 1000);
  assert.ok(result.length < 1200);
  assert.match(result, /retrieval truncated/);
});

test("buildMarker advertises native retrieve tool", () => {
  const marker = buildMarker("hr_123", {
    compressedText: "short",
    tokensBefore: 1000,
    tokensAfter: 250,
    tokensSaved: 750,
    compressionRatio: 0.25,
    transforms: ["router:log:0.25"],
    proxyCcrHashes: ["abc"],
  });
  assert.match(marker, /headroom_retrieve/);
  assert.match(marker, /hr_123/);
  assert.match(marker, /750 tokens/);
  assert.match(marker, /router:log/);
});

test("status helpers summarize session savings", () => {
  const stats = initialStats();
  stats.tokensBefore = 1000;
  stats.tokensSaved = 600;
  assert.equal(savingsPercent(stats), 60);
  assert.equal(formatCount(1500), "1.5k");
  assert.match(statusText(true, "managed", stats), /headroom managed · saved 600 tok · 60% ↓/);
  assert.equal(statusText(false, "none", stats), "headroom off");
});
