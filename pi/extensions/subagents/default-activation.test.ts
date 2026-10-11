import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeActivation } from "./activation.ts";
import { createSupervisor } from "./supervisor.ts";

async function fixture(run: (home: string, cwd: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "subagents-default-"));
  try {
    const home = join(root, "home"), cwd = join(root, "project");
    await mkdir(home); await mkdir(join(cwd, ".pi"), { recursive: true });
    await run(home, cwd);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("normal package activation needs no environment flag or config and writes nothing", async () => {
  await fixture(async (home, cwd) => {
    const config = await nativeActivation(home, cwd, "");
    assert.equal(config.enabled, true);
    assert.deepEqual([config.concurrency, config.threads, config.slots, config.pending], [3, 4, 8, 4]);
    assert.equal(config.routing, "headroom-preferred");
    assert.deepEqual([config.persist, config.schedules, config.workflows], [false, false, false]);
    assert.deepEqual(await readdir(home), []);
  });
});

test("default deployment executes three sibling children while the fourth queues", async () => {
  await fixture(async (home, cwd) => {
    const config = await nativeActivation(home, cwd, "");
    let serial = 0;
    const releases: (() => void)[] = [];
    const service = createSupervisor({
      ...config,
      nextId: () => String(++serial),
      createBackend: async () => ({
        abort: async () => {},
        dispose: async () => {},
        run: () => new Promise<{ outcome: "completed"; complete: boolean }>(resolve => {
          releases.push(() => resolve({ outcome: "completed", complete: true }));
        }),
      }),
    });
    try {
      const runs = [];
      for (let i = 0; i < 4; i++) {
        const run = await service.start({ prompt: `Research lane ${i}` });
        assert.equal(run.ok, true);
        if (!run.ok) throw Error("default deployment rejected a sibling");
        runs.push(run.runId);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(releases.length, 3);
      releases[0]();
      await service.wait([runs[0]]);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(releases.length, 4);
      releases.forEach(release => release());
      assert.ok((await service.wait(runs)).every(result => result.outcome === "completed"));
    } finally {
      releases.forEach(release => release());
      await service.dispose();
    }
  });
});

test("environment and global configuration support explicit opt-out", async () => {
  await fixture(async (home, cwd) => {
    assert.equal(await nativeActivation(home, cwd, "0"), undefined);
    await writeFile(join(home, "subagents-native.json"), '{"version":1,"enabled":false}');
    assert.equal(await nativeActivation(home, cwd, ""), undefined);
    assert.equal(await nativeActivation(home, cwd, "1"), undefined);
  });
});

test("existing validated configuration remains unchanged; malformed config fails closed", async () => {
  await fixture(async (home, cwd) => {
    const path = join(home, "subagents-native.json");
    for (const concurrency of [1, 2, 6]) {
      const source = JSON.stringify({ version: 1, enabled: true, concurrency, routing: "native" });
      await writeFile(path, source);
      assert.equal((await nativeActivation(home, cwd, "")).concurrency, concurrency);
      assert.equal(await readFile(path, "utf8"), source);
    }
    await writeFile(path, '{"version":1,"enabled":true,"concurrency":100}');
    await assert.rejects(nativeActivation(home, cwd, ""), /caps/);
    await writeFile(path, '{');
    await assert.rejects(nativeActivation(home, cwd, ""), SyntaxError);
  });
});

test("legacy companion sources suppress default registration, explicit activation rejects conflicts", async () => {
  await fixture(async (home, cwd) => {
    for (const path of [join(home, "settings.json"), join(cwd, ".pi/settings.json")]) {
      for (const settings of [
        { packages: ["npm:@tintinweb/pi-subagents@0.14.3"] },
        { packages: [{ source: "npm:@tintinweb/pi-subagents" }] },
        { extensions: ["/private/node_modules/@tintinweb/pi-subagents/index.ts"] },
      ]) {
        await writeFile(path, JSON.stringify(settings));
        assert.equal(await nativeActivation(home, cwd, ""), undefined);
        await assert.rejects(nativeActivation(home, cwd, "1"), /Companion conflict/);
      }
      await rm(path);
    }
  });
});
