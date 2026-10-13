import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A fresh process resolves homedir() before importing the real hook. No SDK
// runtime or personal configuration is loaded; all state lives in temporary HOME.
test("registered hook handles custom, user and legacy turns without leaking phrase triggers", () => {
	const home = mkdtempSync(join(tmpdir(), "caveman-hooks-"));
	try {
		const moduleUrl = new URL("./index.ts", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			const { default: register, DEFAULT_CONFIG, saveCavemanConfig } = await import(${JSON.stringify(moduleUrl)});
			function setup() {
				const handlers = new Map(), entries = [];
				register({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, appendEntry(...args) { entries.push(args); } });
				const ctx = { ui: { setStatus() {}, theme: { fg: (_role, text) => text } } };
				return { run: event => handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "Base", ...event }, ctx), entries };
			}
			const { run, entries } = setup();
			const custom = { messageType: "custom", message: { customType: "pi-subagent:wake", content: "normal mode", display: false } };
			assert.match((await run(custom)).systemPrompt, /^Base\\n\\nIMPORTANT: You are in CAVEMAN MODE/);
			assert.equal(entries.length, 0, "custom content cannot change session level");
			assert.match((await run({ ...custom, prompt: "normal mode" })).systemPrompt, /CAVEMAN MODE/);
			assert.equal(entries.length, 0, "custom events never act as user phrase commands");
			assert.match((await run({ messageType: "user", prompt: "hello" })).systemPrompt, /CAVEMAN MODE/);
			assert.equal(await run({ messageType: "user", prompt: "normal mode" }), undefined);
			assert.equal(entries.at(-1)[1].level, "off");
			assert.equal(await run(custom), undefined, "custom turn preserves off state");
			assert.match((await run({ prompt: "be brief" })).systemPrompt, /CAVEMAN MODE/);
			assert.equal(entries.at(-1)[1].level, "full", "legacy Pi user events still trigger");
			assert.match((await run({ messageType: "user", prompt: undefined })).systemPrompt, /CAVEMAN MODE/);
			await saveCavemanConfig({ ...DEFAULT_CONFIG, autoTrigger: false });
			const disabled = setup();
			assert.match((await disabled.run(custom)).systemPrompt, /CAVEMAN MODE/);
			assert.match((await disabled.run({ messageType: "user", prompt: "normal mode" })).systemPrompt, /CAVEMAN MODE/);
			assert.equal(disabled.entries.length, 0);
		`], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
