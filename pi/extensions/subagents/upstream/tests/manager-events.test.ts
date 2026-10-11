import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";

// Isolate detached runs: node:test installs rejection handlers, whereas Pi runs with
// Node's default fatal unhandled-rejection behavior.
for (const scenario of ["settled", "running", "failed-prompt", "all-events"]) {
  test(`notification failure cannot crash a detached runner: ${scenario}`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { ThreadManager } from ${JSON.stringify(new URL("../src/orch/manager.ts", import.meta.url).href)};
      const scenario = ${JSON.stringify(scenario)};
      const errors = [];
      const events = [];
      const manager = new ThreadManager({
        rootSnapshot: () => [],
        getType: name => ({ name, description: 'test', systemPrompt: 'test' }),
        toolsFor: () => [],
        onEvent(event) {
          events.push(event.kind);
          if (scenario === 'all-events' || event.kind === 'settled' ||
              (scenario !== 'settled' && event.thread.state === 'running')) {
            throw new Error('notification failed');
          }
        },
        onEventError(error, event) {
          errors.push(event.kind);
          assert.match(error.message, /notification failed/);
          // The diagnostic sink must not become another crash path.
          if (scenario === 'all-events') throw new Error('diagnostic failed');
        },
        createDriver: async options => ({
          async prompt() {
            await new Promise(resolve => setImmediate(resolve));
            manager.update(options.path, 'progress');
            options.onEvent({ kind: 'usage', inputTokens: 1, outputTokens: 1, partial: true });
            if (scenario === 'failed-prompt') throw new Error('model failed');
          },
          steer: async () => {}, snapshot: () => [], output: () => 'answer',
          abort: async () => {}, dispose: () => {}, sendUpdate: () => {},
        }),
      });
      await manager.spawn('/root', { path: 'worker', type: 'worker', task: 'task', wait: false });
      // Do not call wait(): a waiter would attach a rejection handler to record.run.
      await new Promise(resolve => setTimeout(resolve, 100));
      const worker = manager.get('worker');
      assert.equal(worker.state, scenario === 'failed-prompt' ? 'failed' : 'completed');
      if (scenario === 'failed-prompt') assert.equal(worker.error, 'model failed');
      else assert.equal(worker.output, 'answer');
      assert.ok(errors.includes('settled'));
      assert.ok(events.includes('metrics'));
      assert.ok(events.includes('update'));
      if (scenario === 'all-events') {
        for (const kind of ['change', 'metrics', 'update', 'settled']) assert.ok(errors.includes(kind));
      }
      await manager.shutdown();
    `;
    const result = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}

