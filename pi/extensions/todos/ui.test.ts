import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import todosExtension from "./index.ts";

test("interactive manager renders narrow Unicode tasks, preserves focus, and closes", async (t) => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-todos-ui-"));
	const oldPath = process.env.PI_TODO_PATH;
	process.env.PI_TODO_PATH = path.join(cwd, "todos");
	t.after(async () => {
		if (oldPath === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = oldPath;
		await rm(cwd, { recursive: true, force: true });
	});
	let tool: any;
	let command: any;
	todosExtension({ registerTool(value: any) { tool = value; }, registerCommand(_name: string, value: any) { command = value; }, on() {} } as any);
	const ctx: any = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "ui-test", getSessionFile: () => "ui-test.jsonl" } };
	await tool.execute("create", { action: "create", title: "Unicode 日本語 🌿 and long task title" }, undefined, undefined, ctx);
	let closed = false;
	ctx.ui = {
		async custom(factory: any) {
			const tui = { requestRender() {}, terminal: { rows: 24 } };
			const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } };
			const keys = { matches(data: string, id: string) { return data === id; } };
			const component = factory(tui, theme, keys, () => { closed = true; });
			component.focused = true;
			assert.equal(component.focused, true);
			for (const width of [20, 40, 80]) {
				const lines = component.render(width);
				assert.ok(lines.length > 0);
				assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
			}
			component.invalidate();
			component.handleInput("tui.select.cancel");
		},
	};
	await command.handler("", ctx);
	assert.equal(closed, true);
});
