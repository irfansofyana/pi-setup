import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Lightweight wiring checks only. Runtime lifecycle coverage lives in index.test.ts.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("only session startup opts out of success notifications", () => {
	assert.match(source, /startManagedProxy = async \(ctx: ExtensionContext, notifySuccess = true\)/);
	assert.match(source, /startCoordinator\.start\(ctx, notifySuccess\)/);
	assert.match(source, /config\.startup === "auto" && !config\.localToolResultCompression\) await startManagedProxy\(ctx, false\)/);
	assert.equal((source.match(/startManagedProxy\(ctx, false\)/g) ?? []).length, 1);
});

test("all startup success paths are guarded; failures retain their separate policy", () => {
	for (const line of source.split("\n").filter(line => /ctx\.ui\.notify\(.+Headroom (?:proxy already running|proxy started|adopted a concurrent)/.test(line))) {
		assert.match(line, /if \(notifySuccess && ctx\.hasUI\)/);
	}
	assert.equal((source.match(/if \(notifySuccess && ctx\.hasUI\)/g) ?? []).length, 3);
	assert.match(source, /notifyLifecycleFailure\(ctx, 'Headroom CLI missing/);
	assert.match(source, /if \(pendingTerminalNotice\) notifyLifecycleFailure/);
});
