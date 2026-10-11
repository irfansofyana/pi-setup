import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./signature.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("./watermark-ui.ts", import.meta.url), "utf8");

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

test("other palette header animation never polls full TUI render tree", () => {
	const header = functionSource("signatureHeader");
	assert.doesNotMatch(header, /tui\.render\s*\(/);
	assert.match(header, /cachedRenderedLineCount\(tui\)/);
	assert.match(header, /renderedLineCount !== undefined/);
});

test("legacy orbit visibility only reads cached normal-render line count", () => {
	const cache = functionSource("cachedRenderedLineCount");
	assert.match(cache, /previousLines/);
	assert.match(cache, /Array\.isArray/);
	assert.doesNotMatch(cache, /\.render\s*\(/);
});

test("Pi theme owns minimal static header, not prominent pulsing banner", () => {
	const lines = functionSource("devSignatureLines");
	assert.match(lines, /formatCwdForFooter/);
	assert.match(lines, /truncateToWidth/);
	assert.doesNotMatch(lines, /PI_LINES|center\(|AUTHOR_CREDIT|frame|orbitLogoLines|gradientText/);
	assert.doesNotMatch(source, /DEVS_PULSE|devPulseColor/);
	assert.match(functionSource("signatureHeader"), /disposed \|\| theme\.name === IRFAN_DEVS_THEME/);
	assert.match(source, /presentation\.dispose\(\)/);
	assert.match(source, /registerCommand\("pi-watermark"/);
});

test("watermark adapter preserves input, uses public layout, and fails closed", () => {
	assert.match(ui, /ctx\.ui\.setWidget/);
	assert.match(ui, /placement: "aboveEditor"/);
	assert.doesNotMatch(ui, /showOverlay|inspectWatermarkLayout|tui\.render\s*\(/);
	assert.match(ui, /ctx\.ui\.getEditorText\(\)/);
	assert.match(ui, /ctx\.ui\.onTerminalInput/);
	assert.match(ui, /welcomeStage/);
	assert.match(source, /args\.trim\(\) === "status"/);
	assert.match(ui, /ctx\.sessionManager\.getEntries\(\)/);
	assert.doesNotMatch(ui, /\.onChange\s*=|previousLines|previousScreen|currentLayout|tui\.render\(|requestRender\(true\)/);
});

test("footer routes stats and statuses through local presentation colors", () => {
	const stats = functionSource("footerStatsLine");
	assert.match(stats, /ink\.cost\(/);
	assert.match(stats, /ink\.model\(/);
	assert.match(stats, /ink\.context\(label, percent\)/);
	assert.match(stats, /theme\.fg\("dim", `\(\$\{ctx\.model\.provider\}\)`\)/);
	const chip = functionSource("compactStatusChip");
	assert.match(chip, /theme\.name === IRFAN_DEVS_THEME \? cavemanLevel\(plain\)/);
	assert.match(chip, /ink\.healthy\(/);
	assert.match(chip, /state === "offline" \? theme\.fg\("error", state\)/);
});

test("footer reads current thinking level each render and favors it over provider prefix", () => {
	const stats = functionSource("footerStatsLine");
	assert.match(stats, /if \(ctx\.model\?\.reasoning\)/);
	assert.match(stats, /`thinking \$\{thinkingLevel\}`/);
	assert.match(stats, /visibleWidth\(withProvider\) <= width/);
	assert.match(functionSource("compactFooter"), /footerStatsLine\(ctx, theme, footerData, width, getThinkingLevel\(\)\)/);
	assert.match(source, /compactFooter\(ctx, presentation, \(\) => pi\.getThinkingLevel\(\)\)/);
});

test("footer uses persisted cost rollup and hides only duplicate cost status", () => {
	assert.match(functionSource("footerStatsLine"), /footerUsage\(ctx\.sessionManager\.getEntries\(\)\)/);
	assert.match(functionSource("footerStatusLine"), /\.filter\(\(\[key\]\) => separateFooterStatus\(key\)\)/);
});

test("footer uses terminal background with bounded line widths", () => {
	const footer = functionSource("compactFooter");
	assert.doesNotMatch(footer, /theme\.bg\(/);
	assert.match(footer, /width - visibleWidth\(clipped\)/);
	assert.match(footer, /presentation\.footer\(component, rendered\.length\)/);
});
