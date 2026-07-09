import test from "node:test";
import assert from "node:assert/strict";

import {
  HashlineSession,
  applyHashlinePatch,
  computeFileTag,
  formatHashlineRead,
  parseHashlineInput,
} from "./index.ts";

const path = "src/app.ts";
const original = ["const a = 1;", "const b = 2;", "console.log(a + b);"].join("\n");

test("computeFileTag returns a stable 4-hex uppercase whole-file tag", () => {
  assert.match(computeFileTag(original), /^[0-9A-F]{4}$/);
  assert.equal(computeFileTag(original), computeFileTag(original));
  assert.notEqual(computeFileTag(original), computeFileTag(`${original}\nchanged`));
});

test("formatHashlineRead emits a file tag and numbered lines", () => {
  const session = new HashlineSession();
  const rendered = formatHashlineRead(session, path, original, { startLine: 2, endLine: 3 });
  const tag = computeFileTag(original);

  assert.equal(rendered, [`[${path}#${tag}]`, "2:const b = 2;", "3:console.log(a + b);"].join("\n"));
  assert.deepEqual(session.snapshot(path, tag)?.seenLines, new Set([2, 3]));
});

test("parseHashlineInput splits sections and operations", () => {
  const tag = computeFileTag(original);
  const patch = parseHashlineInput([
    `[${path}#${tag}]`,
    "SWAP 2.=2:",
    "+const b = 3;",
    "INS.POST 3:",
    "+export {};",
  ].join("\n"));

  assert.equal(patch.sections.length, 1);
  assert.equal(patch.sections[0].path, path);
  assert.equal(patch.sections[0].tag, tag);
  assert.deepEqual(patch.sections[0].operations.map((op) => op.kind), ["swap", "insert"]);
});

test("applyHashlinePatch edits only when the tag matches current content and touched lines were seen", () => {
  const session = new HashlineSession();
  const tag = session.record(path, original, [2, 3]);
  const patch = parseHashlineInput([
    `[${path}#${tag}]`,
    "SWAP 2.=2:",
    "+const b = 3;",
    "INS.POST 3:",
    "+export {};",
  ].join("\n"));

  const result = applyHashlinePatch(session, original, patch.sections[0]);

  assert.equal(result.text, ["const a = 1;", "const b = 3;", "console.log(a + b);", "export {};"].join("\n"));
  assert.equal(result.tag, computeFileTag(result.text));
  assert.equal(result.firstChangedLine, 2);
});

test("applyHashlinePatch rejects unseen anchored lines", () => {
  const session = new HashlineSession();
  const tag = session.record(path, original, [2]);
  const patch = parseHashlineInput([`[${path}#${tag}]`, "SWAP 3.=3:", "+console.log(b);"].join("\n"));

  assert.throws(() => applyHashlinePatch(session, original, patch.sections[0]), /line 3 was not shown/);
});

test("applyHashlinePatch rejects stale file tags with the current tag in the error", () => {
  const session = new HashlineSession();
  const tag = session.record(path, original, [2]);
  const current = original.replace("const a = 1;", "const a = 10;");
  const patch = parseHashlineInput([`[${path}#${tag}]`, "SWAP 2.=2:", "+const b = 3;"].join("\n"));

  assert.throws(() => applyHashlinePatch(session, current, patch.sections[0]), new RegExp(`stale tag ${tag}.*current tag ${computeFileTag(current)}`));
});
