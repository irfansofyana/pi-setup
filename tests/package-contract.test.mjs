import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

test("root manifest exposes the repository as one installable Pi package", async () => {
  const manifest = await readJson("package.json");

  assert.equal(manifest.name, "@irfansofyana/pi-setup");
  assert.equal(manifest.private, true);
  assert.equal(manifest.engines.pi, ">=1.0.0");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(!manifest.pi.extensions.includes("./pi/extensions/pi-signature.ts"), "standalone Signature extension must not return");
  assert.ok(manifest.pi.extensions.includes("./pi/themes/pi-irfan-devs/index.ts"));
  assert.ok(manifest.pi.extensions.includes("./pi/extensions/*/index.ts"));
  assert.ok(manifest.pi.skills.includes("./skills"));
  assert.deepEqual(manifest.pi.prompts, ["./pi/prompts/*.md"]);
  assert.deepEqual(manifest.pi.themes, ["./pi/themes/*.json", "./pi/themes/pi-irfan-devs/theme.json"]);
});

test("package manifest ships every declared resource path", async () => {
  const manifest = await readJson("package.json");

  for (const requiredPath of [
    "pi/themes/pi-irfan-devs/index.ts",
    "pi/themes/pi-irfan-devs/signature.ts",
    "pi/themes/pi-irfan-devs/signature.test.ts",
    "skills/pi-setup/SKILL.md",
    "skills/my-web-search/SKILL.md",
    "skills/my-web-search/references/source-hierarchy.md",
    "skills/my-web-search/references/templates.md",
    "pi/extensions/web-research/package.json",
    "pi/extensions/web-research/evaluation-cases.json",
    "pi/themes/pi-irfan-devs/theme.json",
    "pi/prompts/research.md",
    "pi/prompts/push-changes.md",
  ]) {
    await access(path.join(root, requiredPath));
  }
  await assert.rejects(access(path.join(root, "pi/extensions/command-deck/index.ts")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "pi/extensions/pi-signature.ts")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "pi/extensions/pi-signature.test.ts")), { code: "ENOENT" });

  assert.ok(manifest.files.includes("pi/extensions"));
  assert.ok(manifest.files.includes("pi/themes"));
  assert.ok(manifest.files.includes("pi/agents"));
  assert.ok(manifest.files.includes("pi/prompts"));
  assert.ok(manifest.files.includes("skills"));
});

test("package and lockfile versions agree with reviewed install examples", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  for (const file of ["README.md", "docs/setup/installation.md"]) {
    const docs = await readFile(path.join(root, file), "utf8");
    assert.ok(docs.includes(`pi install git:github.com/irfansofyana/pi-setup@v${manifest.version}`));
  }
});

test("web-research evaluation corpus freezes every required benchmark dimension", async () => {
  const corpus = await readJson("pi/extensions/web-research/evaluation-cases.json");
  const caseIds = new Set(corpus.cases.map((entry) => entry.id));
  for (const id of [
    "current-official-fact",
    "official-documentation-lookup",
    "release-versus-main",
    "conflicting-sources",
    "obscure-technical-error",
    "semantic-discovery",
    "similar-page-discovery",
    "news-freshness",
    "domain-restrictions",
    "partial-batch-fetch",
    "oversized-content",
    "cancel-during-provider-work",
    "operation-timeout",
    "rate-limit-transient-retry",
    "auth-failure-no-fallback",
    "provider-validation-failure",
    "unsafe-url-preflight",
    "ciung-context-isolation",
  ]) assert.ok(caseIds.has(id), `missing frozen evaluation case: ${id}`);

  const metrics = new Set(corpus.metrics);
  for (const metric of [
    "correctness", "primarySourceShare", "claimLevelEvidence", "citationValidity",
    "contradictionCoverage", "unsupportedClaims", "unresolvedClaimsLabeledHonestly",
    "relevance", "providerCost", "latencyMs", "parentVisibleCharacters", "fallbackCount",
    "cancellationStoppedWork", "scopeDiscipline", "toolEfficiency",
  ]) assert.ok(metrics.has(metric), `missing evaluation metric: ${metric}`);
  assert.ok(corpus.comparisonModes.some((mode) => mode.includes("native tools")));
  assert.ok(corpus.comparisonModes.some((mode) => mode.includes("Ciung")));
});

test("pi-irfan-devs ships its editor and has no install mutation", async () => {
  const manifest = await readJson("package.json");

  assert.equal(manifest.piSetup.defaultTheme, "pi-irfan-devs");
  assert.ok(manifest.pi.themes.includes("./pi/themes/pi-irfan-devs/theme.json"));
  assert.ok(manifest.pi.extensions.includes("./pi/themes/pi-irfan-devs/index.ts"));
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[hook], undefined, `package must not define ${hook}`);
  }
});

test("Irfan Devs palette keeps readable dim text", async () => {
  const theme = await readJson("pi/themes/pi-irfan-devs/theme.json");
  assert.equal(theme.name, "pi-irfan-devs");
  assert.equal(theme.appearance, "dark");
  assert.equal(theme.vars.phosphor, "#36ff7a");
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((pair) => parseInt(pair, 16) / 255);
    return rgb.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const resolve = (color) => color.startsWith("#") ? color : theme.vars[color];
  const dim = luminance(resolve(theme.colors.dim));
  for (const background of [theme.vars.terminal, theme.colors.userMessageBg, theme.colors.toolPendingBg, theme.colors.toolSuccessBg, theme.colors.toolErrorBg]) {
    const bg = luminance(resolve(background));
    assert.ok((Math.max(dim, bg) + 0.05) / (Math.min(dim, bg) + 0.05) >= 4.5, `dim contrast below 4.5 on ${background}`);
  }
});

test("setup metadata keeps third-party Pi packages separately managed", async () => {
  const manifest = await readJson("package.json");
  const expected = [
    "npm:@tintinweb/pi-subagents@0.14.3",
    "npm:@juicesharp/rpiv-ask-user-question@2.4.0",
    "npm:@juicesharp/rpiv-todo@2.4.0",
    "npm:pi-stats-ext@0.2.0",
    "npm:@ff-labs/pi-fff@0.10.5",
  ];
  for (const field of ["dependencies", "optionalDependencies", "bundledDependencies"]) {
    assert.equal(manifest[field], undefined, `companions must not appear in ${field}`);
  }
  for (const spec of expected) {
    const name = spec.replace(/^npm:/, "").replace(/@[^@]+$/, "");
    assert.equal(manifest.peerDependencies?.[name], undefined, `${name} must remain a separate Pi source`);
  }
  assert.deepEqual(manifest.piSetup.requiredPackages, expected);
  assert.equal(expected.length, 5);
  assert.ok(!manifest.piSetup.requiredPackages.some((source) => source.includes("pi-permission-system")), "removed permission-system must not return as a requirement");

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const minimums = new Map(
    [...readme.matchAll(/^\| `([^`]+)` \| `>=([^`]+)` \|/gm)].map((match) => [match[1], match[2]]),
  );
  for (const spec of expected) {
    const match = spec.match(/^npm:(.+)@(\d+\.\d+\.\d+)$/);
    assert.ok(match, `required companion must encode npm minimum: ${spec}`);
    assert.equal(minimums.get(match[1]), match[2], `${match[1]} README minimum must match manifest`);
  }
});

test("native MCP guidance uses Pi-owned paths and native server fields", async () => {
  const guide = await readFile(path.join(root, "docs/setup/mcp.md"), "utf8");
  assert.match(guide, /~\/\.pi\/agent\/mcp\.json/);
  assert.match(guide, /`\.pi\/mcp\.json`/);
  assert.match(guide, /\/mcp login work-api/);
  assert.doesNotMatch(guide, /\/mcp setup|\/mcp tools|\/mcp-auth/);
  const allowed = new Set(["command", "args", "env", "cwd", "url", "headers", "oauth", "timeout", "enabled", "exposure", "toolExposure", "description", "type"]);
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(examples.length >= 3);
  for (const [, block] of examples) {
    const config = JSON.parse(block);
    assert.ok(config.mcpServers);
    for (const server of Object.values(config.mcpServers)) {
      assert.ok(Object.keys(server).every((key) => allowed.has(key)), "MCP example includes a non-native server field");
    }
  }
});

test("root Pi manifest loads only repository-owned package resources", async () => {
  const manifest = await readJson("package.json");
  assert.deepEqual(manifest.pi.extensions, [
    "./pi/themes/pi-irfan-devs/index.ts",
    "./pi/extensions/*/index.ts",
  ]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.pi.extensions.every((resource) => !resource.includes("node_modules")));
});

test("documentation keeps companion packages separate from aggregate ownership", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const installation = await readFile(path.join(root, "docs/setup/installation.md"), "utf8");
  const setupSkill = await readFile(path.join(root, "skills/pi-setup/SKILL.md"), "utf8");
  const proposal = await readFile(
    path.join(root, "docs/superpowers/specs/2026-08-09-pi-package-refactor-design.md"),
    "utf8",
  );

  assert.match(readme, /Required companion packages/);
  assert.doesNotMatch(readme, /Bundled third-party packages/);
  assert.match(installation, /Companion packages are installed separately/);
  assert.match(proposal, /Separately managed companion packages/);
  assert.match(setupSkill, /Report static `setEditorComponent\(\)` matches as potential claimants/);
  assert.match(setupSkill, /effective owners only when proven/);
  assert.match(setupSkill, /Never reorder packages during audit/);
});

test("native web extension and my-web-search skill ship as one provider-neutral delivery", async () => {
  const manifest = await readJson("package.json");
  const skill = await readFile(path.join(root, "skills/my-web-search/SKILL.md"), "utf8");
  const hierarchy = await readFile(path.join(root, "skills/my-web-search/references/source-hierarchy.md"), "utf8");
  const templates = await readFile(path.join(root, "skills/my-web-search/references/templates.md"), "utf8");

  assert.ok(manifest.pi.extensions.includes("./pi/extensions/*/index.ts"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.match(skill, /^name: my-web-search$/m);
  assert.match(skill, /^description: Use when substantial public-web research needs multiple sources, current evidence, or citation verification\./m);
  assert.match(skill, /web_search/);
  assert.match(skill, /web_fetch/);
  assert.match(skill, /search snippets[^\n]*cannot confirm material claims/i);
  assert.match(skill, /contradictory|disconfirming/i);
  assert.match(skill, /stop[^\n]*evidence/i);
  assert.doesNotMatch(skill, /ninerouter|9router-web-researcher|\bmcp\s*\(/i);
  assert.match(hierarchy, /versioned official documentation/i);
  assert.match(hierarchy, /peer-reviewed primary paper/i);
  assert.match(hierarchy, /Reuters or AP/i);
  assert.match(templates, /claim \| status \| primary source \| version\/date \| conflicts/i);
  assert.match(templates, /Goal:/);
  assert.match(templates, /Search\/turn\/time budget:/);
});
