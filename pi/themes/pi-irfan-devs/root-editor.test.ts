import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRootEditorInput, getRootEditorKeybindings, isRootEditor, markRootEditor, onRootEditorInput, withRootEditorInput, type RootEditorKeybindings } from "./root-editor.ts";

const bindings = (): RootEditorKeybindings => ({ matches: () => false, getResolvedBindings: () => ({}) });

test("root identity does not extend to dialog instances, descendants or copies", () => {
	class Editor {
		onSubmit = (_text: string) => {};
	}
	const root = new Editor();
	assert.equal(isRootEditor(root), false);
	assert.equal(markRootEditor(root), root);
	assert.equal(isRootEditor(root), true);
	assert.equal(isRootEditor(new Editor()), false);
	assert.equal(isRootEditor(Object.create(root)), false);
	assert.equal(isRootEditor({ ...root }), false);
});

test("root marking leaves the editor and host callbacks untouched", () => {
	const onSubmit = (_text: string) => {};
	const root = Object.freeze({ onSubmit });
	assert.equal(markRootEditor(root), root);
	assert.equal(markRootEditor(root), root);
	assert.equal(isRootEditor(root), true);
	assert.deepEqual(Reflect.ownKeys(root), ["onSubmit"]);
	assert.equal(root.onSubmit, onSubmit);
});

test("separate module loads recognize the same root instances", async () => {
	const duplicateUrl = new URL("./root-editor.ts", import.meta.url);
	duplicateUrl.search = "duplicate-root-editor-test";
	const duplicate = await import(duplicateUrl.href);
	assert.notEqual(duplicate.markRootEditor, markRootEditor);
	const firstBindings = bindings(), secondBindings = bindings();
	const first = markRootEditor({}, firstBindings);
	const second = duplicate.markRootEditor({}, secondBindings);
	assert.equal(duplicate.isRootEditor(first), true);
	assert.equal(isRootEditor(second), true);
	assert.equal(duplicate.getRootEditorKeybindings(first), firstBindings);
	assert.equal(getRootEditorKeybindings(second), secondBindings);
	const off = duplicate.onRootEditorInput(first, () => true);
	assert.equal(dispatchRootEditorInput(first, "left"), true);
	off();
	assert.equal(dispatchRootEditorInput(first, "left"), false);
});

test("installed app keybindings belong only to their exact root editor", () => {
	const firstBindings = bindings(), replacementBindings = bindings();
	const root = {};
	assert.equal(getRootEditorKeybindings(root), undefined);
	markRootEditor(root, firstBindings);
	assert.equal(getRootEditorKeybindings(root), firstBindings);
	assert.equal(getRootEditorKeybindings(Object.create(root)), undefined);
	assert.equal(getRootEditorKeybindings(markRootEditor({})), undefined);
	markRootEditor(root);
	assert.equal(getRootEditorKeybindings(root), firstBindings);
	markRootEditor(root, replacementBindings);
	assert.equal(getRootEditorKeybindings(root), replacementBindings);
});

test("unknown values and editor-shaped objects do not acquire root identity", () => {
	for (const candidate of [undefined, null, false, 0, "editor", Symbol("editor"), () => {}, { onSubmit() {}, getText() { return ""; } }]) {
		assert.equal(isRootEditor(candidate), false);
		assert.equal(getRootEditorKeybindings(candidate), undefined);
	}
});

test("root input subscriptions are exact-instance, disposable and stop at consumption", () => {
	const root = markRootEditor({}), dialog = {};
	const calls: string[] = [];
	const offDialog = onRootEditorInput(dialog, () => { calls.push("dialog"); return true; });
	const offFirst = onRootEditorInput(root, data => { calls.push(`first:${data}`); return true; });
	const offSecond = onRootEditorInput(root, data => { calls.push(`second:${data}`); return false; });
	assert.equal(dispatchRootEditorInput(dialog, "left"), false);
	assert.equal(dispatchRootEditorInput(Object.create(root), "left"), false);
	assert.equal(dispatchRootEditorInput(root, "left"), true);
	assert.deepEqual(calls, ["first:left"]);
	offFirst(); offFirst();
	assert.equal(dispatchRootEditorInput(root, "right"), false);
	assert.deepEqual(calls, ["first:left", "second:right"]);
	offSecond(); offDialog();
	assert.equal(dispatchRootEditorInput(root, "left"), false);
});

test("extension shortcuts run once before cooperative root navigation", () => {
	for (const shortcutConsumes of [false, true]) {
		const calls: string[] = [];
		const root = markRootEditor({ onExtensionShortcut(data: string) {
			assert.equal(this, root);
			calls.push(`shortcut:${data}`);
			return shortcutConsumes;
		} });
		const original = root.onExtensionShortcut;
		onRootEditorInput(root, data => { calls.push(`navigation:${data}`); return true; });
		withRootEditorInput(root, "left", () => {
			calls.push("native dispatch");
			if (!root.onExtensionShortcut("left")) calls.push("native editing");
		});
		assert.deepEqual(calls, shortcutConsumes
			? ["native dispatch", "shortcut:left"]
			: ["native dispatch", "shortcut:left", "navigation:left"]);
		assert.equal(root.onExtensionShortcut, original);
	}
});

test("unconsumed input continues native editing with the original callback restored", () => {
	const root = markRootEditor({ onExtensionShortcut: undefined as ((data: string) => boolean) | undefined });
	let nativeEdits = 0, dispatches = 0;
	onRootEditorInput(root, () => false);
	withRootEditorInput(root, "x", () => {
		dispatches++;
		if (!root.onExtensionShortcut?.("x")) nativeEdits++;
	});
	assert.equal(dispatches, 1);
	assert.equal(nativeEdits, 1);
	assert.equal(root.onExtensionShortcut, undefined);
});

test("unmarked dialog input retains its callback throughout native dispatch", () => {
	const original = () => false;
	const dialog = { onExtensionShortcut: original };
	let dispatches = 0;
	withRootEditorInput(dialog, "left", () => {
		dispatches++;
		assert.equal(dialog.onExtensionShortcut, original);
	});
	assert.equal(dispatches, 1);
	assert.equal(isRootEditor(dialog), false);
});

test("native input failure restores the shortcut callback and dispatch depth", () => {
	const original = (_data: string) => false;
	const root = markRootEditor({ onExtensionShortcut: original });
	let navigationCalls = 0;
	onRootEditorInput(root, () => { navigationCalls++; return true; });
	assert.throws(() => withRootEditorInput(root, "left", () => { throw Error("native failure"); }), /native failure/);
	assert.equal(root.onExtensionShortcut, original);
	withRootEditorInput(root, "left", () => { assert.equal(root.onExtensionShortcut("left"), true); });
	assert.equal(navigationCalls, 1);
});

test("a replacement shortcut installed during input is not overwritten on cleanup", () => {
	const original = () => false, replacement = () => true;
	const root = markRootEditor({ onExtensionShortcut: original });
	withRootEditorInput(root, "left", () => { root.onExtensionShortcut = replacement; });
	assert.equal(root.onExtensionShortcut, replacement);
});

test("reentrant input preserves native shortcut dispatch without duplicating root hooks", () => {
	const calls: string[] = [];
	const root = markRootEditor({ onExtensionShortcut(data: string) {
		calls.push(`shortcut:${data}`);
		if (data === "outer") input("nested");
		return false;
	} });
	const original = root.onExtensionShortcut;
	onRootEditorInput(root, data => { calls.push(`navigation:${data}`); return true; });
	function input(data: string) {
		withRootEditorInput(root, data, () => {
			calls.push(`native:${data}`);
			if (!root.onExtensionShortcut(data)) calls.push(`editing:${data}`);
		});
	}
	input("outer");
	assert.deepEqual(calls, ["native:outer", "shortcut:outer", "native:nested", "shortcut:nested", "editing:nested", "navigation:outer"]);
	assert.equal(root.onExtensionShortcut, original);
});
