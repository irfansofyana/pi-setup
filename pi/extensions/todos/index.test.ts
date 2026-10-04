import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, access, utimes, stat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import todosExtension from "./index.ts";

async function fixture(t: any) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-todos-test-"));
	const oldPath = process.env.PI_TODO_PATH;
	delete process.env.PI_TODO_PATH;
	t.after(async () => {
		if (oldPath === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = oldPath;
		await rm(cwd, { recursive: true, force: true });
	});
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	todosExtension({
		registerTool(tool: any) { tools.push(tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as any);
	const ctx: any = {
		cwd, mode: "print", hasUI: false,
		sessionManager: { getSessionId: () => "session-a", getSessionFile: () => "session-a.jsonl" },
	};
	const call = (params: any, context = ctx) => tools[0].execute("call", params, undefined, undefined, context);
	return { cwd, dir: path.join(cwd, ".pi/todos"), tools, commands, events, ctx, call };
}

// Environment overrides are restored after each test; tests intentionally run serially.
test("registers bundled tool and command without creating storage on startup", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.tools.map((tool) => tool.name), ["todo"]);
	assert.deepEqual([...f.commands.keys()], ["todos"]);
	assert.equal(f.tools[0].executionMode, "sequential");
	await f.events.get("session_start")({}, f.ctx);
	await assert.rejects(access(f.dir), { code: "ENOENT" });
	assert.deepEqual((await f.call({ action: "list" })).details.todos, []);
});

test("CRUD round trips JSON front matter, markdown, tags, and IDs", async (t) => {
	const f = await fixture(t);
	const created = await f.call({ action: "create", title: 'Fix {escaped "text"}', tags: ["qa"], body: "Initial notes" });
	const id = created.details.todo.id;
	assert.match(id, /^[a-f0-9]{8}$/);
	assert.equal(JSON.parse(created.content[0].text).id, `TODO-${id}`);
	const file = path.join(f.dir, `${id}.md`);
	assert.match(await readFile(file, "utf8"), /\n\nInitial notes\n$/);
	assert.equal((await f.call({ action: "get", id: `#TODO-${id.toUpperCase()}` })).details.todo.title, 'Fix {escaped "text"}');
	await f.call({ action: "update", id, title: "Updated", body: "Replacement", tags: [] });
	const appended = await f.call({ action: "append", id, body: "Extra" });
	assert.equal(appended.details.todo.body.trim(), "Replacement\n\nExtra");
	assert.deepEqual(appended.details.todo.tags, []);
	assert.deepEqual(await readdir(f.dir), [`${id}.md`]);
	const deleted = await f.call({ action: "delete", id });
	assert.equal(deleted.details.todo.id, id);
	await assert.rejects(access(file), { code: "ENOENT" });
});

test("claims conflict across sessions, force overrides, and closing clears assignment", async (t) => {
	const f = await fixture(t);
	const id = (await f.call({ action: "create", title: "Claim me" })).details.todo.id;
	const other = { ...f.ctx, sessionManager: { getSessionId: () => "session-b", getSessionFile: () => "session-b.jsonl" } };
	assert.equal((await f.call({ action: "claim", id })).details.todo.assigned_to_session, "session-a");
	assert.match((await f.call({ action: "claim", id }, other)).details.error, /already assigned/);
	assert.match((await f.call({ action: "release", id }, other)).details.error, /force/);
	assert.equal((await f.call({ action: "claim", id, force: true }, other)).details.todo.assigned_to_session, "session-b");
	assert.equal((await f.call({ action: "release", id, force: true })).details.todo.assigned_to_session, undefined);
	await f.call({ action: "claim", id });
	const closed = await f.call({ action: "update", id, status: "done" });
	assert.equal(closed.details.todo.assigned_to_session, undefined);
	assert.deepEqual((await f.call({ action: "list" })).details.todos, []);
	assert.equal((await f.call({ action: "list-all" })).details.todos.length, 1);
	assert.match((await f.call({ action: "claim", id })).details.error, /closed/);
});

test("rejects path traversal and missing parameters; ignores unrelated markdown", async (t) => {
	const f = await fixture(t);
	await f.call({ action: "create", title: "Valid" });
	await writeFile(path.join(f.dir, "README.md"), "Not a task");
	for (const action of ["get", "update", "append", "delete", "claim", "release"]) {
		assert.match((await f.call({ action, id: "../../outside" })).details.error, /Invalid todo id/);
		assert.match((await f.call({ action })).details.error, /id required/);
	}
	assert.match((await f.call({ action: "create" })).details.error, /title required/);
	assert.equal((await f.call({ action: "list-all" })).details.todos.length, 1);
});

test("fresh and stale locks fail closed until verified manual cleanup", async (t) => {
	const f = await fixture(t);
	const id = (await f.call({ action: "create", title: "Locked" })).details.todo.id;
	const lock = path.join(f.dir, `${id}.lock`);
	await writeFile(lock, JSON.stringify({ session: "other", created_at: new Date().toISOString() }));
	assert.match((await f.call({ action: "update", id, title: "Blocked" })).details.error, /locked/);
	assert.equal((await f.call({ action: "get", id })).details.todo.title, "Locked");
	await utimes(lock, new Date(0), new Date(0));
	assert.match((await f.call({ action: "update", id, title: "Recovered" })).details.error, /stale/);
	const interactive = { ...f.ctx, hasUI: true, ui: { confirm: async () => { throw new Error("Must not offer unsafe takeover"); } } };
	assert.match((await f.call({ action: "update", id, title: "Recovered" }, interactive)).details.error, /stale/);
	await access(lock);
	await rm(lock);
	assert.equal((await f.call({ action: "update", id, title: "Recovered" }, interactive)).details.todo.title, "Recovered");
	await assert.rejects(access(lock), { code: "ENOENT" });
});

test("GC stays off by default and opt-in removes only old closed valid task files", async (t) => {
	const f = await fixture(t);
	const closed = (await f.call({ action: "create", title: "Old closed", status: "closed" })).details.todo;
	const open = (await f.call({ action: "create", title: "Old open" })).details.todo;
	for (const todo of [closed, open]) {
		todo.created_at = new Date(0).toISOString();
		await writeFile(path.join(f.dir, `${todo.id}.md`), JSON.stringify(todo));
	}
	const unrelated = path.join(f.dir, "notes.md");
	await writeFile(unrelated, JSON.stringify(closed));
	await f.events.get("session_start")({}, f.ctx);
	await access(path.join(f.dir, `${closed.id}.md`));
	await writeFile(path.join(f.dir, "settings.json"), JSON.stringify({ gc: true, gcDays: 7 }));
	const lock = path.join(f.dir, `${closed.id}.lock`);
	await writeFile(lock, "{}");
	await f.events.get("session_start")({}, f.ctx);
	await access(path.join(f.dir, `${closed.id}.md`));
	await rm(lock);
	await f.events.get("session_start")({}, f.ctx);
	await assert.rejects(access(path.join(f.dir, `${closed.id}.md`)), { code: "ENOENT" });
	await access(path.join(f.dir, `${open.id}.md`));
	await access(unrelated);
});

test("malformed GC settings fail closed and only boolean true enables deletion", async (t) => {
	const f = await fixture(t);
	const todo = (await f.call({ action: "create", title: "Keep", status: "closed" })).details.todo;
	const file = path.join(f.dir, `${todo.id}.md`);
	todo.created_at = new Date(0).toISOString();
	await writeFile(file, JSON.stringify(todo));
	for (const settings of [null, [], "true", { gc: "false" }, { gc: "true" }, { gc: 1 }, { gc: false }]) {
		await writeFile(path.join(f.dir, "settings.json"), JSON.stringify(settings));
		await f.events.get("session_start")({}, f.ctx);
		await access(file);
	}
});

test("atomic updates preserve private file mode and new tasks start private", async (t) => {
	const f = await fixture(t);
	const id = (await f.call({ action: "create", title: "Private" })).details.todo.id;
	const file = path.join(f.dir, `${id}.md`);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await chmod(file, 0o600);
	await f.call({ action: "update", id, body: "Private notes" });
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await f.call({ action: "append", id, body: "More private notes" });
	assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("relative and absolute PI_TODO_PATH resolve independently of default storage", async (t) => {
	const f = await fixture(t);
	process.env.PI_TODO_PATH = "custom/tasks";
	const id = (await f.call({ action: "create", title: "Relative" })).details.todo.id;
	await access(path.join(f.cwd, "custom/tasks", `${id}.md`));
	process.env.PI_TODO_PATH = path.join(f.cwd, "absolute");
	const next = (await f.call({ action: "create", title: "Absolute" })).details.todo.id;
	await access(path.join(f.cwd, "absolute", `${next}.md`));
	await assert.rejects(access(f.dir), { code: "ENOENT" });
});

test("RPC command notifies filtered results without custom TUI or stdout pollution", async (t) => {
	const f = await fixture(t);
	await f.call({ action: "create", title: "Alpha unique", tags: ["qa"] });
	await f.call({ action: "create", title: "Beta other" });
	const logged: string[] = [];
	t.mock.method(console, "log", () => { throw new Error("RPC stdout must stay JSON-only"); });
	await f.commands.get("todos").handler("unique", { ...f.ctx, mode: "rpc", hasUI: true, ui: {
		notify(text: string) { logged.push(text); },
		custom() { throw new Error("TUI must not run"); },
	} });
	assert.match(logged[0], /Alpha unique/);
	assert.doesNotMatch(logged[0], /Beta other/);
});
