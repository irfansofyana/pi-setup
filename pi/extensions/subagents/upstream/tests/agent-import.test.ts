import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  importWasOffered,
  markImportOffered,
  offerAgentImport,
} from "../src/prefs/agent-import.ts";
import { ConfigStore } from "../src/prefs/config.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const homeDir = join(root, "home");
  for (const dir of [agentDir, cwd, homeDir]) mkdirSync(dir);
  const messages: string[] = [],
    notices: string[] = [],
    confirmations: string[] = [],
    selectCalls: string[][] = [];
  const choices = {
    consent: true,
    selected: [] as string[] | undefined,
    mode: "tui",
    trusted: false,
  };
  const ctx = {
    cwd,
    hasUI: true,
    get mode() {
      return choices.mode;
    },
    isProjectTrusted: () => choices.trusted,
    scopedModels: [
      {
        model: {
          provider: "test",
          id: "scoped-model",
          api: "openai-responses",
        },
      },
    ],
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return choices.consent;
      },
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;
  const pi = {
    sendUserMessage: (message: string, options: unknown) => {
      assert.deepEqual(options, { deliverAs: "followUp" });
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const store = new ConfigStore({ cwd, agentDir, includeProject: false });
  const source = (name: string, scope: "user" | "project" = "user") => {
    const dir = scope === "user" ? join(agentDir, "agents") : join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(
      path,
      `---\nname: ${name}\ndescription: Source ${name}\nmodel: fuzzy\ntools: read, bash\n---\nUNTRUSTED ${name} prompt\n`,
    );
    return path;
  };
  const run = (firstRun = true) =>
    offerAgentImport(pi, ctx, {
      agentDir,
      store,
      homeDir,
      extraAgentDirs: "",
      firstRun,
      select: async (_ctx, items) => {
        selectCalls.push(items.map((item) => item.id));
        return choices.selected?.map(
          (path) => items.find((item) => item.detail.startsWith(`${path}\n`))?.id ?? path,
        );
      },
    });
  return {
    root,
    agentDir,
    cwd,
    homeDir,
    messages,
    notices,
    confirmations,
    selectCalls,
    choices,
    source,
    run,
  };
}

test("first run consent and individual selection enqueue only selected paths, never converted files", async (t) => {
  const f = fixture(t);
  const selected = f.source("selected"),
    other = f.source("other");
  const original = readFileSync(selected, "utf8");
  f.choices.selected = [selected];
  assert.equal(await f.run(), true);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.selectCalls[0]!.length, 2);
  assert.equal(f.messages.length, 1);
  const message = f.messages[0]!;
  assert.ok(message.includes(selected));
  assert.ok(!message.includes(other));
  for (const pattern of [
    /test\/scoped-model/,
    /"api": "openai-responses"/,
  ])
    assert.match(message, pattern);
  assert.ok(!existsSync(join(f.agentDir, "subagent-manager", "agents")));
  assert.equal(readFileSync(selected, "utf8"), original);
  assert.equal(importWasOffered(f.agentDir), false); // Submission is not an acknowledgement.
  markImportOffered(f.agentDir); // Simulate the root before_agent_start acknowledgement.
  assert.equal(await f.run(), false);
  assert.equal(f.confirmations.length, 1);
});

test("decline, empty selection and cancellation never request a model turn", async (t) => {
  for (const [consent, selected] of [
    [true, []],
    [true, undefined],
    [false, ["unused"]],
  ] as const) {
    const f = fixture(t);
    f.source("one");
    f.choices.consent = consent;
    f.choices.selected = selected && [...selected];
    assert.equal(await f.run(), false);
    assert.equal(f.selectCalls.length, consent ? 1 : 0);
    assert.equal(f.messages.length, 0);
    assert.equal(importWasOffered(f.agentDir), true);
  }
});

test("manual import can retry onboarding; project sources require trust", async (t) => {
  const f = fixture(t);
  const user = f.source("one"),
    project = f.source("project", "project");
  markImportOffered(f.agentDir);
  f.choices.selected = [user, project];
  assert.equal(await f.run(false), true);
  assert.equal(f.confirmations.length, 0);
  assert.ok(!f.messages[0]!.includes(project));
  f.choices.trusted = true;
  assert.equal(await f.run(false), true);
  assert.ok(f.messages[1]!.includes(project));
  assert.ok(f.messages[1]!.includes(join(f.cwd, ".pi", "agent", "subagent-manager", "agents")));
});

test("non-TUI does not mark onboarding or send a model turn", async (t) => {
  for (const mode of ["rpc", "print", "json"]) {
    const f = fixture(t);
    f.source("one");
    f.choices.mode = mode;
    assert.equal(await f.run(), false);
    assert.equal(importWasOffered(f.agentDir), false);
    assert.equal(await f.run(false), false);
    assert.equal(f.messages.length + f.selectCalls.length, 0);
    assert.match(f.notices.at(-1)!, /TUI mode/);
  }
});

test("skills alone never open the import offer or selector", async (t) => {
  const f = fixture(t);
  for (const directory of [
    join(f.homeDir, ".agents", "skills", "review"),
    join(f.agentDir, "agents"),
    join(f.cwd, ".agents", "Skills", "review"),
  ]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), "---\nname: review\ndescription: A skill\n---\nX\n");
  }
  f.choices.trusted = true;
  assert.equal(await f.run(), false);
  assert.equal(f.confirmations.length + f.selectCalls.length + f.messages.length, 0);
  assert.equal(importWasOffered(f.agentDir), true); // Nothing to import counts as completed.
});

test("symlinked onboarding state fails closed without touching its target", async (t) => {
  const f = fixture(t);
  const manager = join(f.agentDir, "subagent-manager");
  mkdirSync(manager);
  const target = join(f.root, "target");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(manager, ".import-offered"));
  assert.throws(() => importWasOffered(f.agentDir), /symlink/);
  assert.throws(() => markImportOffered(f.agentDir), /symlink/);
  assert.equal(await f.run(), false);
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.equal(f.messages.length, 0);
});

