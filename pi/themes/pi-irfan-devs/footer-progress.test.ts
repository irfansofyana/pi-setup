import assert from "node:assert/strict";
import test from "node:test";
import { createFooterProgress } from "./footer-progress.ts";

test("progress falls back to editor until a footer is mounted", () => {
	const progress = createFooterProgress();
	assert.equal(progress.isInFooter(), false);
	assert.equal(progress.read(80), undefined);
	const dispose = progress.mountFooter();
	assert.equal(progress.isInFooter(), true);
	dispose();
	dispose();
	assert.equal(progress.isInFooter(), false);
});

test("theme changes can release presentation back to the editor without unmounting", () => {
	const progress = createFooterProgress();
	let active = true;
	progress.mountFooter(() => active);
	assert(progress.isInFooter());
	active = false;
	assert(!progress.isInFooter());
	active = true;
	assert(progress.isInFooter());
});

test("disposing an old footer cannot detach its replacement", () => {
	const progress = createFooterProgress();
	const old = progress.mountFooter();
	const current = progress.mountFooter();
	old();
	assert(progress.isInFooter());
	current();
	assert(!progress.isInFooter());
});

test("read native presentation live; reader replacement drops stale editors", () => {
	const progress = createFooterProgress();
	let label = "Consulting rubber duck…";
	progress.setReader(width => ({ text: label.slice(0, width), spinner: "•", isQuip: true }));
	assert.equal(progress.read(3)?.text, "Con");
	label = "Recalculating π…";
	assert.equal(progress.read(80)?.text, label);
	progress.setReader(() => undefined);
	assert.equal(progress.read(80), undefined);
});

test("session reset drops readers and footer ownership without stale disposal races", () => {
	const progress = createFooterProgress();
	progress.setReader(() => ({ text: "Retrying", spinner: "•", isQuip: false }));
	const old = progress.mountFooter();
	progress.reset();
	assert(!progress.isInFooter());
	assert.equal(progress.read(80), undefined);
	progress.mountFooter();
	old();
	assert(progress.isInFooter());
});
