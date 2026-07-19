import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pi-signature.ts", import.meta.url), "utf8");

function functionSource(name: string): string {
	const start = source.indexOf(`function ${name}`);
	assert.notEqual(start, -1, `${name} must exist`);

	const bodyStart = source.indexOf("{", start);
	let depth = 0;
	for (let index = bodyStart; index < source.length; index++) {
		if (source[index] === "{") depth++;
		if (source[index] === "}") depth--;
		if (depth === 0) return source.slice(start, index + 1);
	}

	throw new Error(`Could not parse ${name}`);
}

test("header animation timer never polls the full TUI render tree", () => {
	const header = functionSource("signatureHeader");
	assert.doesNotMatch(header, /tui\.render\s*\(/);
	assert.match(header, /cachedRenderedLineCount\(tui\)/);
	assert.match(header, /renderedLineCount !== undefined/);
});

test("header visibility reads the cached normal-render line count", () => {
	const cache = functionSource("cachedRenderedLineCount");
	assert.match(cache, /previousLines/);
	assert.match(cache, /Array\.isArray/);
	assert.doesNotMatch(cache, /\.render\s*\(/);
});
