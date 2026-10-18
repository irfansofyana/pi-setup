import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { buildCiSuites } from "../scripts/test-ci.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFile(resolve(root, file), "utf8");

test("browser ships via existing package resources without new runtime dependencies", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.ok(manifest.pi.extensions.includes("./pi/extensions/*/index.ts"));
  assert.ok(manifest.pi.skills.includes("./pi/skills"));
  assert.equal(manifest.dependencies["chrome-devtools-mcp"], undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
  for (const file of ["index.ts", "controller.ts", "extension.ts", "preferences.ts", "preferences.test.ts", "README.md", "evaluation-cases.json"]) {
    await access(resolve(root, "pi/extensions/browser", file));
  }
});

test("browser skills cover authority limits, bounded outputs and unverified identity", async () => {
  const setup = await read("pi/skills/browser-setup/SKILL.md");
  const assist = await read("pi/skills/browser-assist/SKILL.md");
  assert.match(setup, /^name: browser-setup$/m);
  assert.match(assist, /^name: browser-assist$/m);
  for (const pattern of [/read-only/i, /numbered proposals/i, /Chrome.*144/, /IT approval/, /private backup/, /\/reload/, /Do not use shell\/CLI/]) assert.match(setup, pattern);
  for (const pattern of [/untrusted data/, /isError/, /bounded/, /autosave/, /completeness/, /unsaved/, /session logs/, /not verified browser attachment/, /not.*OS sandbox/]) assert.match(assist, pattern);
  assert.match(assist, /`close_page`.*requested\/confirmed targets/);
  assert.match(assist, /order does not establish age/);
  for (const file of ["pi/extensions/browser/README.md", "docs/setup/mcp.md"]) {
    const docs = await read(file);
    assert.match(docs, /full standard tool/i);
    assert.doesNotMatch(docs, /`close_page` is hidden|performance\/network\/emulation tool categories are disabled/);
  }
  for (const [file, content] of [["pi/skills/browser-setup/SKILL.md", setup], ["pi/skills/browser-assist/SKILL.md", assist]]) {
    for (const [, target] of content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      await access(resolve(root, dirname(file), target));
    }
  }
});

test("remembered setup docs preserve the four-command interface and Chrome consent", async () => {
  const docs = await read("docs/setup/mcp.md");
  const setup = await read("pi/skills/browser-setup/SKILL.md");
  const component = await read("pi/extensions/browser/README.md");
  for (const text of [docs, setup, component]) {
    assert.match(text, /\/browser enable/);
    assert.match(text, /\/browser disable/);
    assert.match(text, /\/browser status/);
    assert.doesNotMatch(text, /\/browser (?:connect|disconnect)\b/);
    assert.match(text, /Chrome.*approval|Chrome.*permission/);
    assert.match(text, /TUI\/RPC/);
  }
  assert.match(component, /\.config\.lock/);
  assert.match(component, /unknown JSON keys are preserved/);
  assert.match(docs, /Print\/JSON sessions do not auto-register/);
  assert.match(setup, /Never restore removed legacy MCP definitions/);
});

test("active instructions and research command examples contain no removed commands", async () => {
  for (const file of ["AGENTS.md", "README.md", "docs/setup/mcp.md", "docs/setup/local-extensions.md", "docs/setup/skills-and-tools.md", "docs/setup/chrome-browser-research.md", "docs/setup/chrome-browser-alternatives-research.md", "pi/extensions/browser/README.md", "pi/skills/browser-setup/SKILL.md", "pi/skills/browser-assist/SKILL.md"]) {
    assert.doesNotMatch(await read(file), /\/browser (?:connect|disconnect)\b/, file);
  }
});

test("consolidated CI keeps browser SDK import and test coverage", async () => {
  assert.match(await read(".github/workflows/test.yml"), /npm run test:ci/);
  for (const version of ["1.0.0", "1.1.0", "1.3.0"]) {
    const suites = buildCiSuites(root, version);
    assert.match(suites[0].args.at(-1), /pi\/extensions\/browser\/index\.ts/);
    const extensions = suites.find(suite => suite.name === "Extensions").args;
    for (const file of ["browser.test.ts", "preferences.test.ts"]) assert.ok(extensions.includes(`pi/extensions/browser/${file}`));
  }
});

test("scenario corpus is explicitly not a completed live skill evaluation", async () => {
  const corpus = JSON.parse(await read("pi/extensions/browser/evaluation-cases.json"));
  assert.equal(corpus.status, "not_run");
  assert.doesNotMatch(JSON.stringify(corpus), /\/browser (?:connect|disconnect)\b/);
  const ids = new Set(corpus.cases.map((entry) => entry.id));
  for (const id of ["remembered-session-reuse", "remembered-revocation", "removed-lifecycle-commands", "approved-tab-cleanup", "ambiguous-old-tabs", "read-only-setup", "managed-policy-denied", "existing-mcp-conflict", "scoped-summary-injection", "paginated-table", "stale-or-closed-tab", "autosave-and-submit", "unsaved-work-and-artifacts"]) assert.ok(ids.has(id));
  for (const entry of corpus.cases) {
    assert.ok(["browser-setup", "browser-assist"].includes(entry.skill));
    assert.ok(entry.prompt.length > 20 && entry.expected.length >= 2);
  }
});
