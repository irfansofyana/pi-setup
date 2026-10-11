import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import {
  ToolExecutionComponent,
  createBashToolDefinition,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { renderTranscriptTool } from "../src/ui/transcript-tool.ts";

initTheme("dark");

test("observer shell rendering matches pi's native component in preview and full detail", () => {
  const args = { command: "printf 'hello'", timeout: 30 };
  const result = {
    content: [
      { type: "text" as const, text: Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n") },
    ],
    details: {},
    isError: false,
  };
  const definition = createBashToolDefinition(process.cwd());
  for (const detail of ["preview", "full"] as const) {
    const native = new ToolExecutionComponent(
      "bash",
      "shell",
      args,
      { showImages: false },
      definition,
      { requestRender() {} } as TUI,
      process.cwd(),
    );
    native.updateResult(result, false);
    native.setExpanded(detail === "full");
    for (const width of [20, 80])
      assert.deepEqual(
        renderTranscriptTool("bash", "shell", args, result, false, false, detail, width),
        native.render(width),
      );
  }
});

test("observer edit rendering uses the recorded diff and never reads current files", async (t) => {
  const read = t.mock.method(fs, "readFile", async () => {
    throw new Error("observer must not read files");
  });
  const args = { path: "missing.ts", edits: [{ oldText: "old", newText: "new" }] };
  const result = {
    content: [{ type: "text", text: "Successfully replaced text" }],
    details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
  };
  const rows = renderTranscriptTool("edit", "edit", args, result, false, false, "full", 80);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read.mock.callCount(), 0);
  const content = stripTerminalSequences(rows.join("\n"));
  assert.match(content, /missing\.ts/);
  assert.match(content, /old/);
  assert.match(content, /new/);
});

test("observer strips controls from arguments, details and results; images remain placeholders", () => {
  const rows = renderTranscriptTool(
    "unknown\x1b]2;title\x07",
    "id",
    { path: "\x1b[31mfile\x00" },
    {
      content: [
        { type: "text", text: "\x1b[31moutput\x00" },
        { type: "image", data: "PAYLOAD", mimeType: "image/jpeg" },
      ],
      details: { diff: "\x1b[31muntrusted" },
    },
    false,
    false,
    "full",
    60,
  );
  const content = stripTerminalSequences(rows.join("\n"));
  assert.doesNotMatch(content, /\x1b|\x00|PAYLOAD|title/);
  assert.match(content, /file/);
  assert.match(content, /output/);
  assert.match(content, /text-only observer/);
  for (const row of rows) assert.ok(visibleWidth(row) <= 60);
});

test("cyclic tool args, metadata and unknown content cannot crash the observer", () => {
  const cyclic: Record<string, unknown> = { label: "cyclic" };
  cyclic.self = cyclic;
  const rows = renderTranscriptTool(
    "unknown",
    "id",
    cyclic,
    { content: [cyclic], details: cyclic },
    false,
    false,
    "full",
    80,
  );
  assert.match(stripTerminalSequences(rows.join("\n")), /\[Circular\]/);
});

