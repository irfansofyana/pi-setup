import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree, inspectWorktree, assertWritable, validateWorktree,recoverWorktree,discardWorktree,reviewWorktree } from "./worktrees.ts";
const exec = promisify(execFile);

test("owned worktree uses committed base, retains changes, and rejects escaped or forged write targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-")), repo = join(root, "repo"), store = join(root, "store");
  try {
    await mkdir(repo); await exec("git", ["init", "--quiet", repo]);
    await writeFile(join(repo, "tracked.txt"), "committed\n");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-C", repo, "commit", "--quiet", "-m", "fixture"]);
    const base = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repo, "tracked.txt"), "dirty parent\n");
    const lease = await createWorktree({ repo, root: store, base, files: ["tracked.txt", "new/", "allowed/", "~/", "@/"] });
    assert.equal(await validateWorktree(lease), true);
    assert.equal(await readFile(join(lease.path, "tracked.txt"), "utf8"), "committed\n");
    await assertWritable(lease, "tracked.txt");
    await writeFile(join(lease.path, "tracked.txt"), "child change\n");
    await assertWritable(lease, "new/nested/file.txt");
    assert.equal(await assertWritable(lease,"~/file.txt"),join(lease.path,"~/file.txt"));
    assert.equal(await assertWritable(lease,"@/file.txt"),join(lease.path,"@/file.txt"));
    await assert.rejects(assertWritable(lease,"new/name\u00a0with-space"),/forbidden/);
    await mkdir(join(lease.path,"protected"));
    await symlink(join(lease.path,"protected"),join(lease.path,"allowed"));
    await assert.rejects(assertWritable(lease,"allowed/file.txt"),/forbidden/);
    const artifact = await inspectWorktree(lease);
    assert.equal(artifact.base, base); assert.equal(artifact.dirty, true);
    assert.equal(artifact.path, lease.path); assert.match(artifact.branch, /^pi-subagent\//);
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "dirty parent\n");
    for (const path of ["../repo/tracked.txt", join(repo, "tracked.txt"), ".git", "unapproved.txt"]) {
      await assert.rejects(assertWritable(lease, path), /forbidden/);
    }
    await symlink(repo, join(lease.path, "new"));
    await assert.rejects(assertWritable(lease, "new/tracked.txt"), /forbidden/);
    assert.equal(await validateWorktree({ ...lease }), false);
    const recovered=await recoverWorktree(store,lease.id);assert.equal(await validateWorktree(recovered),true);
    const reviewed=await inspectWorktree(recovered);
    const contentReview=await reviewWorktree(recovered);
    await assert.rejects(discardWorktree(recovered,{expectedStatus:reviewed.status,discardDirty:false}),/dirty/);
    await assert.rejects(discardWorktree(recovered,{expectedStatus:"stale",discardDirty:true}),/drift/);
    await assert.rejects(discardWorktree({...recovered},{expectedStatus:reviewed.status,discardDirty:true}),/owned/);
    await writeFile(join(recovered.path,"tracked.txt"),"changed after human review\n");
    await assert.rejects(discardWorktree(recovered,{expectedStatus:reviewed.status,expectedFingerprint:contentReview.fingerprint,discardDirty:true}),/drift/);
    await writeFile(join(recovered.path,"tracked.txt"),"child change\n");
    await discardWorktree(recovered,{expectedStatus:reviewed.status,expectedFingerprint:contentReview.fingerprint,discardDirty:true});
    assert.equal(await validateWorktree(recovered),false);
    assert.equal(await readFile(join(repo,"tracked.txt"),"utf8"),"dirty parent\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree creation rejects movable bases and unbounded path scopes before git changes", async () => {
  for (const options of [{ base: "HEAD", files: ["src/"] }, { base: "a".repeat(40), files: ["../"] }, { base: "a".repeat(40), files: [] }]) {
    await assert.rejects(createWorktree({ repo: "/unused", root: "/unused", ...options }), /invalid/);
  }
});
