import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

test("root manifest exposes the repository as one installable Pi package", async () => {
  const manifest = await readJson("package.json");

  assert.equal(manifest.name, "@irfansofyana/pi-setup");
  assert.equal(manifest.private, true);
  assert.equal(manifest.engines.pi, ">=0.84.1");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(manifest.pi.extensions.includes("./pi/extensions/pi-signature.ts"));
  assert.ok(manifest.pi.extensions.includes("./pi/extensions/*/index.ts"));
  assert.ok(manifest.pi.skills.includes("./skills"));
  assert.deepEqual(manifest.pi.themes, ["./pi/themes/*.json"]);
});

test("package manifest ships every declared resource path", async () => {
  const manifest = await readJson("package.json");

  for (const requiredPath of ["pi/extensions/pi-signature.ts", "skills/pi-setup/SKILL.md", "pi/themes/irfan-sumi.json"]) {
    await access(path.join(root, requiredPath));
  }

  assert.ok(manifest.files.includes("pi/extensions"));
  assert.ok(manifest.files.includes("pi/themes"));
  assert.ok(manifest.files.includes("pi/agents"));
  assert.ok(manifest.files.includes("skills"));
});

test("package ships an approval-gated global automatic-delegation prompt", async () => {
  const manifest = await readJson("package.json");
  const templatePath = "templates/global/APPEND_SYSTEM.md";
  const template = await readFile(path.join(root, templatePath), "utf8");
  const setupSkill = await readFile(path.join(root, "skills/pi-setup/SKILL.md"), "utf8");

  assert.ok(manifest.files.includes("templates"));
  assert.match(template, /pi-setup:auto-delegation:start/);
  assert.match(template, /pi-setup:auto-delegation:end/);
  assert.match(template, /does not need to request delegation/i);
  assert.match(template, /at most two agents initially/i);
  for (const role of ["Ciung", "Laya", "Sangkur", "Prabu"]) {
    assert.match(template, new RegExp(role));
  }
  assert.match(setupSkill, /APPEND_SYSTEM\.md/);
  assert.match(setupSkill, /marker-managed merge/i);
  assert.match(setupSkill, /exactly one ordered start\/end marker pair/i);
  assert.match(setupSkill, /zero managed markers/i);
  assert.match(setupSkill, /classify .*blocked.*make no change/i);
});

test("npm pack includes the automatic-delegation template", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
  });
  const [pack] = JSON.parse(stdout);
  const paths = pack.files.map((file) => file.path);

  assert.ok(paths.includes("templates/global/APPEND_SYSTEM.md"));
});

test("irfan-sumi is the documented package default without mutating settings on install", async () => {
  const manifest = await readJson("package.json");

  assert.equal(manifest.piSetup.defaultTheme, "irfan-sumi");
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[hook], undefined, `package must not define ${hook}`);
  }
});

test("setup metadata keeps third-party Pi packages separately managed", async () => {
  const manifest = await readJson("package.json");
  const expected = [
    "npm:pi-mcp-adapter@2.21.1",
    "npm:@tintinweb/pi-subagents@0.14.3",
    "npm:@gotgenes/pi-permission-system@24.0.0",
    "npm:context-mode@1.0.169",
    "npm:@juicesharp/rpiv-ask-user-question@2.4.0",
    "npm:pi-markdown-preview@0.11.3",
    "npm:@juicesharp/rpiv-todo@2.4.0",
    "npm:pi-9router-ext@0.2.3",
    "npm:pi-stats-ext@0.2.0",
  ];
  for (const field of ["dependencies", "optionalDependencies", "bundledDependencies"]) {
    assert.equal(manifest[field], undefined, `companions must not appear in ${field}`);
  }
  for (const spec of expected) {
    const name = spec.replace(/^npm:/, "").replace(/@[^@]+$/, "");
    assert.equal(manifest.peerDependencies?.[name], undefined, `${name} must remain a separate Pi source`);
  }
  assert.deepEqual(manifest.piSetup.requiredPackages, expected);
});

test("root Pi manifest loads only repository-owned package resources", async () => {
  const manifest = await readJson("package.json");
  assert.deepEqual(manifest.pi.extensions, [
    "./pi/extensions/pi-signature.ts",
    "./pi/extensions/*/index.ts",
  ]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.pi.extensions.every((resource) => !resource.includes("node_modules")));
});

test("documentation keeps companion packages separate from aggregate ownership", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const installation = await readFile(path.join(root, "docs/setup/installation.md"), "utf8");
  const proposal = await readFile(
    path.join(root, "docs/superpowers/specs/2026-08-09-pi-package-refactor-design.md"),
    "utf8",
  );

  assert.match(readme, /Required companion packages/);
  assert.doesNotMatch(readme, /Bundled third-party packages/);
  assert.match(installation, /Companion packages are installed separately/);
  assert.match(proposal, /Separately managed companion packages/);
});
