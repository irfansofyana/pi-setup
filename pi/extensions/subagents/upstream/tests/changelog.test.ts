import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import {
  completePullRequests,
  previousTag,
  releaseBody,
  renderChangelog,
  versionTags,
  type PullRequest,
  type ReleaseNotes,
} from "../.github/scripts/changelog.ts";

const notes = (tag: string, body = "## What's Changed\n* Example PR"): ReleaseNotes => ({
  ...versionTags([tag])[0],
  date: "2026-01-01",
  body,
});

const pr = (number: number, sha = String(number)): PullRequest => ({
  number,
  title: `Change ${number}`,
  html_url: `https://github.com/owner/repo/pull/${number}`,
  merged_at: "2026-01-01T00:00:00Z",
  merge_commit_sha: sha,
  user: { login: "contributor" },
});

test("version tags use SemVer ordering, not lexical ordering; invalid tags are ignored", () => {
  const tags = versionTags([
    "v1.9.0",
    "v1.10.0",
    "v1.10.0-rc.10",
    "v1.10.0-rc.2",
    "v01.0.0",
    "not-a-tag",
    "1.0.0",
  ]);
  assert.deepEqual(
    tags.map(({ tag }) => tag),
    ["v1.10.0", "v1.10.0-rc.10", "v1.10.0-rc.2", "v1.9.0"],
  );
});

test("stable releases include the full stable range and exclude non-ancestor tags", () => {
  const tags = versionTags(["v1.2.0", "v1.2.0-rc.1", "v1.1.9", "v1.1.0", "v1.0.0"]);
  const ancestor = (tag: string) => tag !== "v1.1.9";
  assert.equal(previousTag(tags[0], tags, ancestor), "v1.1.0");
  assert.equal(previousTag(tags[1], tags, ancestor), "v1.1.0");
  assert.equal(previousTag(tags.at(-1)!, tags, ancestor), undefined);
  const rcs = versionTags(["v1.2.0-rc.2", "v1.2.0-rc.1", "v1.1.0"]);
  assert.equal(
    previousTag(rcs[0], rcs, () => true),
    "v1.2.0-rc.1",
  );
});

test("PR completeness checks include bots/unlabelled PRs only in the actual commit range", () => {
  const pulls = [
    pr(1),
    pr(10),
    { ...pr(2), merged_at: null },
    pr(3),
    { ...pr(4), merge_commit_sha: null },
    { ...pr(5), user: { login: "dependabot[bot]" } },
  ];
  const body = `## What's Changed\n* Already included ${pulls[1].html_url}`;
  const result = completePullRequests(body, pulls, new Set(["1", "10", "2", "5"]));
  assert.match(result, /pull\/1\n/); // #10 must not accidentally suppress #1.
  assert.match(result, /@dependabot\[bot\]/);
  assert.doesNotMatch(result, /pull\/2\b|pull\/3\b|pull\/4\b/);
  assert.equal((result.match(/pull\/10\b/g) ?? []).length, 1);
  assert.equal(completePullRequests(result, pulls, new Set(["1", "10", "5"])), result);
});

test("regeneration replaces automatic notes while retaining handwritten highlights", () => {
  const initial = releaseBody("## Highlights\nManual summary", "## What's Changed\nOld PR");
  const updated = releaseBody(`${initial}\nMore manual notes`, "## What's Changed\nNew PR");
  assert.match(updated, /Manual summary/);
  assert.match(updated, /More manual notes/);
  assert.match(updated, /New PR/);
  assert.doesNotMatch(updated, /Old PR/);
  assert.equal(releaseBody(updated, "## What's Changed\nNew PR"), updated);
});

test("major, minor and patch headings nest with the latest major/minor groups first", () => {
  const markdown = renderChangelog(
    [notes("v1.0.0"), notes("v1.2.0"), notes("v1.2.1"), notes("v1.1.0"), notes("v2.0.0")],
    "owner/repo",
  );
  assert.match(markdown, /^## \[v1\.0\.0\].*Major release/m);
  assert.match(markdown, /^### \[v1\.2\.0\].*Minor release/m);
  assert.match(markdown, /^#### \[v1\.2\.1\].*Patch release/m);
  assert.match(markdown, /^##### What's Changed/m);
  assert.ok(markdown.indexOf("[v2.0.0]") < markdown.indexOf("[v1.0.0]"));
  assert.ok(markdown.indexOf("[v1.2.0]") < markdown.indexOf("[v1.1.0]"));
});

test("missing initial tags get series headings, prereleases stay separate, code fences stay intact", () => {
  const markdown = renderChangelog(
    [
      notes(
        "v0.1.1",
        "# Summary\n```sh\n## literal heading in code\n```\n~~~md\n# also literal\n~~~",
      ),
      notes("v1.0.0-rc.1"),
    ],
    "owner/repo",
  );
  assert.match(markdown, /^## 0\.x — Pre-1\.0 releases/m);
  assert.match(markdown, /^### 0\.1\.x/m);
  assert.match(markdown, /^#### \[v0\.1\.1\]/m);
  assert.match(markdown, /^##### Summary/m);
  assert.match(markdown, /```sh\n## literal heading in code\n```/);
  assert.match(markdown, /~~~md\n# also literal\n~~~/);
  assert.match(markdown, /^## Prereleases/m);
  assert.match(markdown, /^### \[v1\.0\.0-rc\.1\].*Prerelease/m);
});

test("workflow has tag/manual triggers and notes have no exclusion filters", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/changelog.yml", import.meta.url), "utf8"),
  );
  assert.ok(workflow.on.push.tags.includes("v[0-9]+.[0-9]+.[0-9]+"));
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.equal(workflow.concurrency, undefined); // Pending tag runs must not get dropped.
  const config = parse(readFileSync(new URL("../.github/release.yml", import.meta.url), "utf8"));
  assert.deepEqual(config.changelog.categories[0].labels, ["*"]);
  assert.equal(config.changelog.exclude, undefined);
});

