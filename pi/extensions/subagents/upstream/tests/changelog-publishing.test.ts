import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, ".github/scripts/changelog.ts");
const repository = "owner/repo";
const tags = ["v1.2.0", "v1.2.0-rc.1", "v1.1.0"];
const pr = (number: number, title: string, sha: string, login: string) => ({
  number,
  title,
  html_url: `https://github.com/${repository}/pull/${number}`,
  merged_at: "2026-03-01T00:00:00Z",
  merge_commit_sha: sha,
  user: { login },
});
// #7 is only on pulls page 2. Generated notes mention #1, so inclusion proves pagination.
const pulls = [
  [pr(1, "Listed", "sha-1", "alice")],
  [pr(7, "From the second page", "sha-7", "bob")],
];
const notes: Record<string, string> = {
  "v1.1.0": "## What's Changed\n* Initial release",
  "v1.2.0-rc.1": "## What's Changed\n* Release candidate",
  "v1.2.0": "## What's Changed\n* Listed by @alice in https://github.com/owner/repo/pull/1",
  "v1.3.0": "## What's Changed\n* Refreshed tag",
};
const dates: Record<string, string> = {
  "v1.1.0": "2026-01-15",
  "v1.2.0-rc.1": "2026-02-15",
  "v1.2.0": "2026-03-15",
  "v1.3.0": "2026-04-15",
};
const commits: Record<string, string[]> = {
  "v1.1.0": ["sha-base"],
  "v1.1.0..v1.2.0-rc.1": ["sha-rc"],
  "v1.1.0..v1.2.0": ["sha-1", "sha-7"],
  "v1.2.0..v1.3.0": ["sha-13"],
};

interface Call {
  cmd: string;
  args: string[];
  input: Record<string, unknown> | null;
}
interface Fixture {
  releases?: unknown[][];
  files?: { sha: string; text: string }[];
  putStatus?: number[];
  contentsError?: string;
  tagsAfterFetch?: string[];
}

const pathOf = (call: Call) => call.args.find((arg) => arg.startsWith("repos/")) ?? "";
const methodOf = (call: Call) => {
  const index = call.args.indexOf("--method");
  return index < 0 ? "GET" : call.args[index + 1];
};
const releaseWrites = (calls: Call[]) =>
  calls.filter((call) => call.cmd === "gh" && /\/releases(?:\/\d+)?$/.test(pathOf(call)));
const filePuts = (calls: Call[]) => calls.filter((call) => methodOf(call) === "PUT");
const decoded = (call: Call) =>
  Buffer.from(String(call.input?.content ?? ""), "base64").toString("utf8");

// PATH shims record every call. A tag added only on the second fetch models a concurrent publish.
const cli = String.raw`#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { join, basename } = require("node:path");
const dir = process.env.FAKE_DIR;
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const args = process.argv.slice(2);
const cmd = basename(process.argv[1]);
const input = args.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : null;
const logPath = join(dir, "calls.json");
const calls = JSON.parse(readFileSync(logPath, "utf8"));
calls.push({ cmd, args, input });
writeFileSync(logPath, JSON.stringify(calls));
const fail = (message) => { console.error(message); process.exit(1); };
const methodOf = (argv) => { const i = argv.indexOf("--method"); return i < 0 ? "GET" : argv[i + 1]; };
if (cmd === "git") {
  const fetches = calls.filter((call) => call.cmd === "git" && call.args[0] === "fetch").length;
  if (args[0] === "tag" && args[1] === "--list") {
    console.log((fetches >= 2 && scenario.tagsAfterFetch ? scenario.tagsAfterFetch : scenario.tags).join("\n"));
  } else if (args[0] === "merge-base" && args[1] === "--is-ancestor") process.exit(0);
  else if (args[0] === "rev-list") console.log((scenario.commits[args[1]] || []).join("\n"));
  else if (args[0] === "show") {
    const tag = String(args.at(-1)).split("^{")[0];
    if (!scenario.dates[tag]) fail("no date for " + tag);
    console.log(scenario.dates[tag]);
  } else if (args[0] === "fetch" && args[1] === "origin" && args[2] === "--tags") process.exit(0);
  else fail("unexpected git " + args.join(" "));
  process.exit(0);
}
const apiPath = args.find((arg) => arg.startsWith("repos/")) || "";
const method = methodOf(args);
const send = (body) => console.log(JSON.stringify(body));
const prior = calls.filter((call) => methodOf(call.args) === method && call.args.some((arg) => String(arg).includes("/contents/"))).length - 1;
if (args.includes("--paginate") && apiPath.includes("/pulls?")) send(scenario.pulls);
else if (args.includes("--paginate") && apiPath.includes("/releases?")) send(scenario.releases);
else if (method === "GET" && apiPath === "repos/" + scenario.repository) send({ default_branch: scenario.branch });
else if (method === "POST" && apiPath.endsWith("/releases/generate-notes")) {
  if (!scenario.notes[input.tag_name]) fail("no notes for " + input.tag_name);
  send({ body: scenario.notes[input.tag_name] });
} else if (method === "GET" && apiPath.includes("/git/ref/tags/")) send({ ref: apiPath });
else if (method === "GET" && apiPath.includes("/contents/CHANGELOG.md")) {
  if (scenario.contentsError) fail(scenario.contentsError);
  const file = scenario.files[prior];
  if (!file) fail("missing contents fixture");
  send({ sha: file.sha, content: Buffer.from(file.text).toString("base64") });
} else if (method === "PUT" && apiPath.endsWith("/contents/CHANGELOG.md")) {
  const status = (scenario.putStatus || [])[prior] || 200;
  if (status !== 200) fail("HTTP " + status);
  send({ content: { sha: "updated" } });
} else if ((method === "POST" || method === "PATCH") && /\/releases(\/\d+)?$/.test(apiPath)) send({ id: 99 });
else fail("unexpected gh " + method + " " + apiPath);
`;

function run(options: { publish?: boolean; tag?: string; fixture?: Fixture } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-cli-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["gh", "git"]) {
    writeFileSync(join(bin, name), cli);
    chmodSync(join(bin, name), 0o755);
  }
  // `--import tsx` resolves from cwd; the script's own imports resolve from its absolute path.
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "calls.json"), "[]");
  writeFileSync(
    join(dir, "scenario.json"),
    JSON.stringify({
      repository,
      branch: "main",
      tags,
      dates,
      commits,
      notes,
      pulls,
      releases: options.fixture?.releases ?? [[]],
      files: options.fixture?.files ?? [{ sha: "sha-main", text: "outdated changelog" }],
      putStatus: options.fixture?.putStatus ?? [],
      contentsError: options.fixture?.contentsError,
      tagsAfterFetch: options.fixture?.tagsAfterFetch,
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...(options.publish ? ["--publish"] : [])],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_DIR: dir,
        GITHUB_REPOSITORY: repository,
        CHANGELOG_TAG: options.tag ?? "",
      },
    },
  );
  return {
    ...result,
    dir,
    calls: JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")) as Call[],
    changelog: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
  };
}

function use(t: TestContext, options?: Parameters<typeof run>[0], status = 0) {
  const result = run(options);
  t.after(() => rmSync(result.dir, { recursive: true, force: true }));
  assert.equal(result.status, status, result.stderr);
  return result;
}

test("preview writes CHANGELOG.md and does not publish a release or file", (t) => {
  const result = use(t);
  assert.match(result.changelog, /From the second page/);
  assert.match(result.changelog, /\/pull\/7\b/);
  assert.match(result.changelog, /Additional merged pull requests/);
  assert.equal(releaseWrites(result.calls).length, 0);
  assert.equal(filePuts(result.calls).length, 0);
  assert.equal(
    result.calls.some((call) => call.args[0] === "fetch" || pathOf(call).includes("/git/ref/")),
    false,
  );
});

test("publish creates the current release and updates main with the contents SHA", (t) => {
  const result = use(t, { publish: true, tag: "v1.2.0" });
  const created = releaseWrites(result.calls);
  const input = created[0]?.input ?? {};
  assert.equal(created.length, 1);
  assert.equal(methodOf(created[0]), "POST");
  assert.equal(pathOf(created[0]), `repos/${repository}/releases`);
  assert.deepEqual(
    [input.tag_name, input.name, input.draft, input.prerelease, input.make_latest],
    ["v1.2.0", "v1.2.0", false, false, "true"],
  );
  assert.match(String(input.body), /From the second page/);
  assert.equal(
    result.calls.find((call) => call.input?.tag_name === "v1.2.0")?.input?.previous_tag_name,
    "v1.1.0",
  );
  const put = filePuts(result.calls);
  assert.equal(put.length, 1);
  assert.equal(put[0].input?.sha, "sha-main");
  assert.equal(put[0].input?.branch, "main");
  assert.match(String(put[0].input?.message), /\[skip ci\]/);
  assert.match(decoded(put[0]), /\/pull\/7\b/);
  assert.match(result.stdout, /Published GitHub Release v1\.2\.0/);
  assert.match(result.stdout, /Updated CHANGELOG\.md on main/);
});

test("existing release on a later page is edited, not recreated, and highlights survive", (t) => {
  const result = use(t, {
    publish: true,
    tag: "v1.2.0",
    fixture: {
      releases: [[], [{ id: 42, tag_name: "v1.2.0", body: "## Highlights\nKeep this note" }]],
    },
  });
  const writes = releaseWrites(result.calls);
  assert.equal(writes.length, 1);
  assert.equal(methodOf(writes[0]), "PATCH");
  assert.equal(pathOf(writes[0]), `repos/${repository}/releases/42`);
  assert.match(String(writes[0].input?.body), /Keep this note/);
  assert.match(String(writes[0].input?.body), /generated-release-notes:start/);
  assert.match(String(writes[0].input?.body), /From the second page/);
  assert.match(result.changelog, /Keep this note/);
});

test("prerelease publish is not marked latest", (t) => {
  const created = releaseWrites(use(t, { publish: true, tag: "v1.2.0-rc.1" }).calls);
  assert.equal(created.length, 1);
  assert.equal(methodOf(created[0]), "POST");
  assert.deepEqual(
    [created[0].input?.tag_name, created[0].input?.prerelease, created[0].input?.make_latest],
    ["v1.2.0-rc.1", true, "false"],
  );
});

test("publish with an empty CHANGELOG_TAG only updates the changelog", (t) => {
  const result = use(t, { publish: true, tag: "" });
  assert.equal(releaseWrites(result.calls).length, 0);
  assert.equal(
    result.calls.some((call) => pathOf(call).includes("/git/ref/tags/")),
    false,
  );
  assert.equal(filePuts(result.calls).length, 1);
  assert.equal(filePuts(result.calls)[0].input?.sha, "sha-main");
  assert.match(result.changelog, /From the second page/);
  assert.doesNotMatch(result.stdout, /Published GitHub Release/);
  assert.match(result.stdout, /Updated CHANGELOG\.md on main/);
});

test("HTTP 409 retries with a fresh SHA and refreshed tags without republishing", (t) => {
  const result = use(t, {
    publish: true,
    tag: "v1.2.0",
    fixture: {
      files: [
        { sha: "sha-old", text: "stale" },
        { sha: "sha-new", text: "still stale" },
      ],
      putStatus: [409, 200],
      tagsAfterFetch: ["v1.3.0", ...tags],
    },
  });
  const puts = filePuts(result.calls);
  const release = releaseWrites(result.calls);
  assert.deepEqual(
    puts.map((call) => call.input?.sha),
    ["sha-old", "sha-new"],
  );
  assert.equal(puts[1].input?.branch, "main");
  assert.doesNotMatch(decoded(puts[0]), /v1\.3\.0/);
  assert.match(decoded(puts[1]), /Refreshed tag/);
  assert.equal(result.calls.filter((call) => call.args[0] === "fetch").length, 2);
  assert.equal(release.length, 1);
  assert.equal(release[0].input?.tag_name, "v1.2.0");
  assert.doesNotMatch(String(release[0].input?.body), /Refreshed tag/);
  assert.match(result.stderr, /Concurrent changelog update; refreshing tags and retrying/);
  assert.match(result.changelog, /\[v1\.3\.0\]/);
  assert.match(result.stdout, /Updated CHANGELOG\.md on main/);
});

test("a missing changelog is created without a SHA", (t) => {
  const result = use(t, {
    publish: true,
    fixture: { contentsError: "HTTP 404: Not Found" },
  });
  const puts = filePuts(result.calls);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].input?.sha, undefined);
  assert.match(decoded(puts[0]), /From the second page/);
});

test("an unchanged changelog does not create another commit", (t) => {
  const preview = use(t);
  const result = use(t, {
    publish: true,
    fixture: { files: [{ sha: "sha-current", text: preview.changelog }] },
  });
  assert.equal(filePuts(result.calls).length, 0);
  assert.match(result.stdout, /already up to date/);
});

test("permission errors fail visibly instead of being treated as missing files", (t) => {
  const result = use(
    t,
    {
      publish: true,
      tag: "v1.2.0",
      fixture: { contentsError: "HTTP 403: Resource not accessible by integration" },
    },
    1,
  );
  assert.match(result.stderr, /HTTP 403: Resource not accessible by integration/);
  assert.doesNotMatch(result.stderr, /HTTP 404/);
  assert.equal(filePuts(result.calls).length, 0);
  assert.doesNotMatch(result.stdout, /Updated CHANGELOG\.md|already up to date/);
});

