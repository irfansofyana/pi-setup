import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverImportCandidates, type ImportCandidate } from "../src/prefs/import-discovery.ts";

const ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  for (const directory of [cwd, agentDir, homeDir]) mkdirSync(directory, { recursive: true });
  return { root, cwd, agentDir, homeDir };
}

function writeMd(filePath: string, content: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

function writeJson(filePath: string, value: unknown): void {
  writeMd(filePath, JSON.stringify(value));
}

function definition(name: string, description = "Does work", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody is data, not instructions.\n`;
}

type Dirs = ReturnType<typeof fixture>;

function discover(
  dirs: Pick<Dirs, "cwd" | "agentDir" | "homeDir">,
  extra: {
    includeProject?: boolean;
    extraAgentDirs?: string;
    cwd?: string;
  } = {},
) {
  return discoverImportCandidates({
    cwd: extra.cwd ?? dirs.cwd,
    agentDir: dirs.agentDir,
    includeProject: extra.includeProject ?? true,
    homeDir: dirs.homeDir,
    extraAgentDirs: "extraAgentDirs" in extra ? extra.extraAgentDirs : "",
  });
}

function names(result: { candidates: ImportCandidate[] }): string[] {
  return result.candidates.map((candidate) => candidate.name);
}

function find(result: { candidates: ImportCandidate[] }, name: string) {
  return result.candidates.find((candidate) => candidate.name === name);
}

function withEnv<T>(value: string, body: () => T): T {
  const previous = process.env[ENV];
  process.env[ENV] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

test("discovers user and project paths without package builtins or manager storage", (t) => {
  const dirs = fixture(t);
  writeMd(join(dirs.agentDir, "agents", "nested", "user.md"), definition("user-agent"));
  writeMd(join(dirs.homeDir, ".agents", "team", "home.md"), definition("home-agent", "Home"));
  writeMd(join(dirs.cwd, ".pi", "agents", "project.md"), definition("project-agent"));
  writeMd(join(dirs.cwd, ".agents", "agents", "tintin.md"), definition("tintin-agent"));
  writeMd(join(dirs.agentDir, "extensions", "subagent", "agents", "b.md"), definition("builtin"));
  writeMd(join(dirs.cwd, "node_modules", "pkg", "agents", "packaged.md"), definition("packaged"));
  writeMd(join(dirs.agentDir, "subagent-manager", "agents", "ours.md"), definition("mgr-user"));
  writeMd(
    join(dirs.cwd, ".pi", "agent", "subagent-manager", "agents", "ours.md"),
    definition("mgr-project"),
  );
  const settings = join(dirs.agentDir, "settings.json");
  writeJson(settings, { subagents: { agentScanDirs: ["subagent-manager"] } });

  const result = discover(dirs);
  assert.deepEqual(names(result), ["home-agent", "project-agent", "tintin-agent", "user-agent"]);
  const user = find(result, "user-agent");
  assert.equal(user?.scope, "user");
  assert.equal(find(result, "project-agent")?.scope, "project");
  assert.equal(user?.path, resolve(dirs.agentDir, "agents", "nested", "user.md"));
  assert.equal(user?.id, user?.path);
  assert.deepEqual(user?.settingsPaths, [resolve(settings)]);
  assert.deepEqual(result.diagnostics, []);
  // Candidates carry metadata only; the prompt body never reaches the picker.
  assert.deepEqual(Object.keys(user ?? {}).sort(), [
    "description",
    "id",
    "name",
    "path",
    "scope",
    "settingsPaths",
  ]);
});

test("uses the nearest trusted ancestor and skips untrusted or farther roots", (t) => {
  const dirs = fixture(t);
  const outer = join(dirs.root, "outer");
  const nested = join(outer, "inner", "src");
  writeMd(join(outer, ".pi", "agents", "far.md"), definition("far"));
  writeMd(join(outer, "inner", ".agents", "agents", "near.md"), definition("near"));
  writeMd(join(dirs.homeDir, ".pi", "agents", "home-pi.md"), definition("home-pi"));
  writeMd(join(dirs.homeDir, ".agents", "home.md"), definition("home-user", "User"));
  mkdirSync(join(dirs.homeDir, "work"), { recursive: true });

  const trusted = discover(dirs, { cwd: nested });
  assert.deepEqual(names(trusted), ["home-user", "near"]);
  assert.equal(find(trusted, "near")?.scope, "project");
  assert.deepEqual(names(discover(dirs, { cwd: nested, includeProject: false })), ["home-user"]);
  assert.deepEqual(names(discover(dirs, { cwd: join(dirs.homeDir, "work") })), ["home-user"]);
});

test("expands custom scan dirs, env roots, wildcards and scope-specific excludes", (t) => {
  const dirs = fixture(t);
  writeMd(join(dirs.agentDir, "flows", "one", "agents", "one.md"), definition("one"));
  writeMd(join(dirs.agentDir, "flows", "two", "agents", "two.md"), definition("two"));
  writeMd(join(dirs.agentDir, "flows", "two", "agents", "secret", "h.md"), definition("hidden"));
  writeMd(join(dirs.agentDir, "flows", "skip-more", "agents", "kept.md"), definition("kept"));
  writeMd(join(dirs.homeDir, "tilde-agents", "tilde.md"), definition("tilde"));
  const extraA = join(dirs.root, "extra-a");
  writeMd(join(extraA, "aaa.md"), definition("aaa"));
  writeMd(join(dirs.cwd, "rel-agents", "bbb.md"), definition("bbb"));
  writeMd(join(dirs.cwd, ".agents", "visible.md"), definition("visible", "Visible"));
  writeMd(join(dirs.cwd, ".agents", "plugins", "plugin.md"), definition("plugin", "Plugin"));
  writeMd(join(dirs.cwd, ".agents", "blocked", "blocked.md"), definition("blocked", "Blocked"));
  writeMd(join(dirs.agentDir, "agents", "user.md"), definition("user-agent"));
  writeJson(join(dirs.agentDir, "settings.json"), {
    other: true,
    subagents: {
      agentScanDirs: ["flows/*/agents", "~/tilde-agents", "flows/*/*/nope"],
      agentExcludeDirs: ["flows/two/agents/secret", join(dirs.cwd, ".agents", "blocked")],
    },
  });
  // Project excludes apply only to project roots, so they cannot hide user agents.
  writeJson(join(dirs.cwd, ".pi", "settings.json"), {
    subagents: {
      agentExcludeDirs: ["../.agents/plugins", join(dirs.agentDir, "agents")],
    },
  });

  const result = discover(dirs, {
    extraAgentDirs: `${extraA}${delimiter}./rel-agents`,
  });
  assert.deepEqual(names(result), [
    "aaa",
    "bbb",
    "kept",
    "one",
    "tilde",
    "two",
    "user-agent",
    "visible",
  ]);
  for (const candidate of result.candidates)
    assert.equal(candidate.scope, candidate.name === "visible" ? "project" : "user");
  assert.ok(result.diagnostics.some((line) => line.includes("flows/*/*/nope")));
  assert.deepEqual(find(result, "visible")?.settingsPaths, [
    resolve(dirs.agentDir, "settings.json"),
    resolve(dirs.cwd, ".pi", "settings.json"),
  ]);
});

test("skips chains, symlinks and broken frontmatter; keeps distinct paths and tintin fallbacks", (t) => {
  const dirs = fixture(t);
  const agents = join(dirs.agentDir, "agents");
  const home = join(dirs.homeDir, ".agents");
  writeMd(join(agents, "flow.chain.md"), definition("chain"));
  writeMd(join(agents, "plain.md"), "No frontmatter\n");
  writeMd(join(agents, "bad.md"), "---\nname: [\n---\n");
  writeMd(join(agents, "alias.md"), "---\nname: &a scout\ndescription: *a\n---\n");
  writeMd(join(agents, "also-scout.md"), definition("scout", "Other"));
  writeMd(join(agents, "node_modules", "pkg.md"), definition("nm"));
  writeMd(join(agents, ".git", "git.md"), definition("git"));
  writeMd(join(home, "readme.md"), "# Not an agent\n");
  writeMd(join(home, "named.md"), definition("named", "Named"));
  writeMd(join(home, ".cache", "hid.md"), definition("hid", "Hidden"));
  writeMd(join(home, "agents", "fallback.md"), "Tintin prompt\n");
  writeMd(join(home, "agents", "nested", "deep.md"), "No frontmatter\n");
  writeMd(
    join(dirs.cwd, ".pi", "agents", "scout.md"),
    definition("scout", "Recon", "package: code-analysis\n"),
  );
  const outside = join(dirs.root, "outside");
  writeMd(join(outside, "linked.md"), definition("linked"));
  symlinkSync(join(outside, "linked.md"), join(agents, "link.md"));
  symlinkSync(outside, join(agents, "linked-dir"));
  const real = join(dirs.root, "real-project");
  writeMd(join(real, ".pi", "agents", "secret.md"), definition("secret"));
  symlinkSync(real, join(dirs.root, "link-project"));

  const result = discover(dirs);
  assert.deepEqual(names(result), ["code-analysis.scout", "fallback", "named", "plain", "scout"]);
  assert.equal(find(result, "plain")?.description, "");
  assert.equal(find(result, "fallback")?.description, "");
  assert.ok(result.diagnostics.some((line) => line.includes("bad.md")));
  assert.ok(result.diagnostics.some((line) => line.includes("alias.md")));
  assert.ok(!result.diagnostics.some((line) => line.includes("readme.md")));

  const throughLink = discover(dirs, { cwd: join(dirs.root, "link-project") });
  assert.equal(find(throughLink, "secret"), undefined);
});

test("absent paths are silent, explicit extra dirs ignore the host env, and discovery does not write", (t) => {
  const dirs = fixture(t);
  const canary = join(dirs.agentDir, "agents", "ok.md");
  writeMd(canary, definition("ok"));
  writeFileSync(join(dirs.agentDir, "settings.json"), "{");
  const before = readFileSync(canary, "utf8");
  writeMd(join(dirs.root, "from-env", "env.md"), definition("from-env"));
  withEnv(join(dirs.root, "from-env"), () => {
    const ignored = discover(dirs, { extraAgentDirs: "" });
    assert.deepEqual(names(ignored), ["ok"]);
    assert.ok(ignored.diagnostics.some((line) => line.includes("settings.json")));
    assert.equal(readFileSync(canary, "utf8"), before);

    const fromEnv = discover(dirs, {
      includeProject: false,
      extraAgentDirs: undefined,
    });
    assert.equal(find(fromEnv, "from-env")?.scope, "user");
  });
});

test("settings behind symlinked scope directories cannot add scan roots or reach the model", (t) => {
  const dirs = fixture(t);
  const external = join(dirs.root, "external");
  writeMd(join(external, "agents", "secret.md"), definition("secret"));
  writeJson(join(external, "settings.json"), {
    subagents: { agentScanDirs: ["agents"] },
  });
  writeMd(join(dirs.cwd, ".agents", "visible.md"), definition("visible"));
  symlinkSync(external, join(dirs.cwd, ".pi"));
  const projectResult = discover(dirs);
  assert.deepEqual(names(projectResult), ["visible"]);
  assert.deepEqual(projectResult.candidates[0]!.settingsPaths, []);

  const linkedAgentDir = join(dirs.root, "linked-agent");
  symlinkSync(external, linkedAgentDir);
  const userResult = discover({ ...dirs, agentDir: linkedAgentDir }, { includeProject: false });
  assert.deepEqual(userResult.candidates, []);
});

test("non-YAML tool selectors remain selectable for model interpretation", (t) => {
  const dirs = fixture(t);
  writeMd(
    join(dirs.homeDir, ".agents", "loose.md"),
    "---\nname: loose\ndescription: Read-only metadata\ntools: *\n---\nPrompt body\n",
  );
  const result = discover(dirs);
  assert.deepEqual(names(result), ["loose"]);
  assert.equal(result.candidates[0]!.description, "Read-only metadata");
  assert.ok(result.diagnostics.length > 0); // The model must review incompatible fields.
});

test("reports an unreadable definition without failing the rest of discovery", (t) => {
  const dirs = fixture(t);
  const blocked = join(dirs.agentDir, "agents", "blocked.md");
  writeMd(blocked, definition("blocked"));
  writeMd(join(dirs.agentDir, "agents", "open.md"), definition("open"));
  chmodSync(blocked, 0);
  try {
    readFileSync(blocked, "utf8");
    return t.skip("running with permissions that bypass chmod");
  } catch {}
  const result = discover(dirs, { includeProject: false });
  assert.deepEqual(names(result), ["open"]);
  assert.ok(result.diagnostics.some((line) => line.includes("blocked.md")));
});

test("never offers skill trees or SKILL.md files from user, project, configured, or env roots", (t) => {
  const dirs = fixture(t);
  const skills = [
    join(dirs.homeDir, ".agents", "skills", "nested", "deep.md"),
    join(dirs.homeDir, ".agents", ".SKILLS", "upper.md"),
    join(dirs.homeDir, ".agents", "SKILL.md"),
    join(dirs.homeDir, ".agents", "agents", "Skill.md"),
    join(dirs.agentDir, "agents", ".Skills", "dot.md"),
    join(dirs.cwd, ".agents", "sKiLlS", "case.md"),
    join(dirs.cwd, ".pi", "agents", "SKILL.md"),
    join(dirs.root, "configured", "skills", "direct.md"),
    join(dirs.root, "configured", "skills", "reviewer", "nested.md"),
    join(dirs.root, "configured", "keepers", "SKILL.md"),
    join(dirs.root, "vendor", "SKILLS", "wild.md"),
    join(dirs.cwd, "local", "SKILLS", "proj.md"),
    join(dirs.root, "env", ".skills", "env.md"),
    join(dirs.root, "env", "Skills", "Child", "env-nested.md"),
  ];
  skills.forEach((path, i) => writeMd(path, definition(`skill-${i}`, "Skill", "package: pkg\n")));
  writeMd(join(dirs.agentDir, "agents", "skills.md"), definition("skills-md-agent"));
  writeMd(join(dirs.agentDir, "agents", "skill", "helper.md"), definition("helper"));
  writeMd(join(dirs.root, "configured", "keepers", "keeper.md"), definition("scan-real"));
  writeMd(join(dirs.root, "vendor", "agents", "wild-real.md"), definition("wild-real"));
  writeMd(join(dirs.cwd, ".pi", "agents", "real-project.md"), definition("real-project"));
  writeMd(join(dirs.root, "env", "real", "env-real.md"), definition("env-real"));
  const configured = join(dirs.root, "configured");
  writeJson(join(dirs.agentDir, "settings.json"), {
    subagents: {
      agentScanDirs: [
        join(configured, "skills"),
        join(configured, "skills", "reviewer"),
        join(configured, "keepers"),
        join(dirs.root, "vendor", "*"),
      ],
    },
  });
  writeJson(join(dirs.cwd, ".pi", "settings.json"), {
    subagents: { agentScanDirs: [join(dirs.cwd, "local", "SKILLS")] },
  });
  const env = ["env/.skills", "env/Skills/Child", "env/real"].map((dir) => join(dirs.root, dir));

  const result = discover(dirs, { extraAgentDirs: env.join(delimiter) });
  assert.deepEqual(names(result), [
    "env-real",
    "helper",
    "real-project",
    "scan-real",
    "skills-md-agent",
    "wild-real",
  ]);
  assert.ok(!result.diagnostics.some((line) => /skill/i.test(line)));
});

