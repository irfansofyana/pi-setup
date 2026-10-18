import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { buildCiSuites, runCiSuites } from "../scripts/test-ci.mjs";

const root = resolve(import.meta.dirname, "..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/test.yml"), "utf8"));

test("one bounded CI matrix covers minimum, pinned and current SDK without duplicate jobs", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["test"]);
  const job = workflow.jobs.test;
  assert.deepEqual(job.strategy.matrix.include, [
    { profile: "minimum", node: "22.19.0", pi: "1.0.0" },
    { profile: "pinned", node: "24.18.0", pi: "1.1.0" },
    { profile: "current", node: "24.18.0", pi: "1.3.0" },
  ]);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(job.strategy.matrix.include[0].node, manifest.engines.node.replace(/^>=/, ""));
  assert.equal(job.strategy.matrix.include[0].pi, manifest.engines.pi.replace(/^>=/, ""));
  assert.equal(job.strategy.matrix.include[1].pi, manifest.devDependencies["@earendil-works/pi-coding-agent"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.strategy["max-parallel"], 1);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  const run = job.steps.find(step => step.run).run;
  for (const pattern of [/--memory=2g --memory-swap=2g --cpus=2 --pids-limit=128/, /timeout --kill-after/, /npm ci/, /npm run test:ci/, /type=bind.*readonly/]) assert.match(run, pattern);
  assert.doesNotMatch(run, /npm run test:ci\s*\|\|/);
  assert.equal(job["continue-on-error"], undefined);
});

test("every extension test runs once; floor omits only experimental routed leases", () => {
  const expected = readdirSync(resolve(root, "pi/extensions"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(resolve(root, "pi/extensions", entry.name))
      .filter(file => file.endsWith(".test.ts"))
      .map(file => `pi/extensions/${entry.name}/${file}`)).sort();
  const tests = version => buildCiSuites(root, version).find(suite => suite.name === "Extensions").args.filter(arg => arg.endsWith(".test.ts"));
  for (const version of ["1.1.0", "1.3.0"]) assert.deepEqual(tests(version), expected);
  assert.deepEqual(expected.filter(file => !tests("1.0.0").includes(file)), [
    "pi/extensions/subagents/headroom-backend.test.ts",
    "pi/extensions/subagents/route-transport.test.ts",
  ]);
  for (const version of ["1.0.0", "1.1.0", "1.3.0"]) {
    const suites = buildCiSuites(root, version);
    assert.match(suites[0].args.at(-1), /pi\/extensions\/browser\/index\.ts/);
    assert.deepEqual(suites.filter(suite => suite.command === "npm").map(suite => suite.args[1]), ["test:package", "test:prompts", "test:subagent-manager", "test:signature"]);
    assert.equal(new Set(tests(version)).size, tests(version).length);
  }
});

test("CI collects suite failures without skipping later suites or reporting false success", () => {
  const calls = [];
  const suites = ["first", "second", "third"].map(name => ({ name, command: "fixture", args: [name] }));
  const failed = runCiSuites(suites, { log() {}, run(_command, args, options) {
    calls.push(args[0]); assert.equal(options.timeout, 300_000);
    return { status: args[0] === "second" ? 0 : 1 };
  } });
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.deepEqual(failed, ["first", "third"]);
  assert.deepEqual(runCiSuites(suites, { log() {}, run: () => ({ status: 0 }) }), []);
  assert.deepEqual(runCiSuites(suites.slice(0, 1), { log() {}, run: () => ({ status: null, error: new Error("spawn failed") }) }), ["first"]);
});
