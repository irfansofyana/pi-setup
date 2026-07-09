import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HashlineSession,
  applyHashlinePatch,
  applyHashlinePatchToFiles,
  computeFileTag,
  formatHashlineRead,
  parseHashlineInput,
  resolveProjectPath,
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

test("applyHashlinePatch preserves BOM and CRLF when producing persisted text", () => {
  const session = new HashlineSession();
  const crlf = "\uFEFFfirst\r\nsecond\r\nthird\r\n";
  const tag = session.record(path, crlf, [2]);
  const patch = parseHashlineInput([`[${path}#${tag}]`, "SWAP 2.=2:", "+SECOND"].join("\n"));

  const result = applyHashlinePatch(session, crlf, patch.sections[0]);

  assert.equal(result.text, "first\nSECOND\nthird\n");
  assert.equal(result.persisted, "\uFEFFfirst\r\nSECOND\r\nthird\r\n");
});

test("applyHashlinePatchToFiles preflights every section before writing any file", () => {
  const session = new HashlineSession();
  const a = "a1\na2";
  const b = "b1\nb2";
  const aTag = session.record("a.ts", a, [2]);
  const bTag = session.record("b.ts", b, [2]);
  const files = new Map([
    ["a.ts", a],
    ["b.ts", "b1\nchanged"],
  ]);
  const writes: string[] = [];
  const patch = parseHashlineInput([
    `[a.ts#${aTag}]`,
    "SWAP 2.=2:",
    "+A2",
    `[b.ts#${bTag}]`,
    "SWAP 2.=2:",
    "+B2",
  ].join("\n"));

  assert.throws(() => applyHashlinePatchToFiles(session, patch, {
    readFile: (filePath) => files.get(filePath) ?? "",
    writeFile: (filePath, text) => {
      writes.push(filePath);
      files.set(filePath, text);
    },
  }), /stale tag/);

  assert.deepEqual(writes, []);
  assert.equal(files.get("a.ts"), a);
});

test("applyHashlinePatchToFiles rejects duplicate target sections", () => {
  const session = new HashlineSession();
  const tag = session.record("a.ts", "a1\na2", [1, 2]);
  const patch = parseHashlineInput([
    `[a.ts#${tag}]`,
    "SWAP 1.=1:",
    "+A1",
    `[a.ts#${tag}]`,
    "SWAP 2.=2:",
    "+A2",
  ].join("\n"));

  assert.throws(() => applyHashlinePatchToFiles(session, patch, {
    readFile: () => "a1\na2",
    writeFile: () => undefined,
  }), /Multiple hashline sections resolve to the same file/);
});

test("resolveProjectPath rejects paths outside the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "hashline-root-"));
  try {
    assert.equal(resolveProjectPath(root, "src/app.ts").absolutePath, join(root, "src/app.ts"));
    assert.throws(() => resolveProjectPath(root, "../secret.txt"), /outside project root/);
    assert.throws(() => resolveProjectPath(root, "/etc/passwd"), /outside project root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
