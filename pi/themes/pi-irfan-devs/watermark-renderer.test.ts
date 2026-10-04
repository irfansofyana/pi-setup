import assert from "node:assert/strict";
import test from "node:test";
import {
  createWatermarkRenderer,
  WATERMARK_REPLAY_MS,
  type WatermarkPainter,
} from "./watermark-renderer.ts";

const identity: WatermarkPainter = (text) => text;
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const bits = [[1, 2, 4, 64], [8, 16, 32, 128]];

function dots(lines: string[]): boolean[][] {
  return Array.from({ length: lines.length * 4 }, (_, y) =>
    Array.from({ length: (lines[0]?.length ?? 0) * 2 }, (_, x) => {
      const char = lines[Math.floor(y / 4)][Math.floor(x / 2)];
      return char !== " " && ((char.charCodeAt(0) - 0x2800) & bits[x % 2][y % 4]) !== 0;
    }),
  );
}

function occupiedWidth(lines: string[]): number {
  const pixels = dots(lines);
  const columns = pixels[0].map((_, x) => pixels.some((row) => row[x]));
  return columns.lastIndexOf(true) - columns.indexOf(true) + 1;
}

function runs(row: boolean[]): number {
  return row.filter((on, x) => on && (x === 0 || !row[x - 1])).length;
}

test("interface duration and stable, deterministic original pi endpoints", () => {
  assert.equal(WATERMARK_REPLAY_MS, 7200);
  const renderer = createWatermarkRenderer();
  const idle = renderer.render(48, 20, null, identity);
  assert.deepEqual(renderer.render(48, 20, null, identity), idle);
  for (const elapsed of [-100, 0, WATERMARK_REPLAY_MS, 1e20, NaN, Infinity, -Infinity]) {
    assert.deepEqual(renderer.render(48, 20, elapsed, identity), idle);
  }
  assert.ok(idle.some((line) => line.trim().length > 0));
});

test("front pi has wide cap, two separate legs, and outward feet", () => {
  const pixels = dots(createWatermarkRenderer().render(48, 20, null, identity));
  const middle = pixels[Math.floor(pixels.length / 2)];
  assert.equal(runs(middle), 2);
  assert.equal(middle[Math.floor(middle.length / 2)], false);
  const middleSpan = middle.lastIndexOf(true) - middle.indexOf(true);
  const upperSpan = Math.max(...pixels.slice(0, 30).map((row) =>
    row.lastIndexOf(true) - row.indexOf(true)));
  const lowerSpan = Math.max(...pixels.slice(55).map((row) =>
    row.lastIndexOf(true) - row.indexOf(true)));
  assert.ok(upperSpan > middleSpan * 1.3, "wide slab cap");
  assert.ok(lowerSpan > middleSpan, "outward feet");
});

test("halfway is front-facing ring badge with smaller pi, not idle silhouette", () => {
  const renderer = createWatermarkRenderer();
  const idle = renderer.render(48, 20, null, identity);
  const badge = renderer.render(48, 20, 3600, identity);
  assert.notDeepEqual(badge, idle);
  assert.deepEqual(renderer.render(48, 20, 3600, identity), badge);
  const pixels = dots(badge);
  // Two ring edges plus two smaller pi legs; center stays open.
  const middle = pixels[Math.floor(pixels.length / 2)];
  assert.equal(runs(middle), 4);
  assert.equal(middle[Math.floor(middle.length / 2)], false);
  const idlePixels = dots(idle);
  const topBadge = pixels.findIndex((row) => row.some(Boolean));
  const topPi = idlePixels.findIndex((row) => row.some(Boolean));
  assert.ok(topBadge < topPi, "ring extends above original pi cap");
});

test("replay rotates through nonempty extruded side profile and morphs smoothly", () => {
  const renderer = createWatermarkRenderer();
  const idle = renderer.render(48, 20, null, identity);
  const badge = renderer.render(48, 20, 3600, identity);
  const shades = new Set<number>();
  const profile = renderer.render(48, 20, 1175, (text, shade) => {
    shades.add(shade);
    return text;
  });
  assert.ok(profile.some((line) => line.trim().length > 0));
  assert.ok(occupiedWidth(profile) < occupiedWidth(idle) * 0.65);
  assert.ok(occupiedWidth(profile) > 5, "edge-on extrusion remains several dots thick");
  assert.ok(shades.size > 1, "extruded/bevel normals receive different light");
  const morph = renderer.render(48, 20, 1800, identity);
  assert.notDeepEqual(morph, idle);
  assert.notDeepEqual(morph, badge);
  assert.notDeepEqual(renderer.render(48, 20, 5700, identity), morph);
  assert.notDeepEqual(renderer.render(48, 20, 700, identity), idle);
  assert.deepEqual(renderer.render(48, 20, 1175, identity), profile);
  // End of second turn converges to idle rather than switching from badge.
  const almostDone = dots(renderer.render(48, 20, 7199, identity));
  const idleDots = dots(idle);
  let changed = 0;
  for (let y = 0; y < idleDots.length; y++) {
    for (let x = 0; x < idleDots[y].length; x++) {
      if (almostDone[y][x] !== idleDots[y][x]) changed++;
    }
  }
  assert.ok(changed < 20);
});

test("invalid dimensions are empty; finite extreme and fractional dimensions clamp", () => {
  const renderer = createWatermarkRenderer();
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, 0.5]) {
    assert.deepEqual(renderer.render(invalid, 20, null, identity), []);
    assert.deepEqual(renderer.render(40, invalid, null, identity), []);
  }
  for (const [width, height, expectedWidth, expectedHeight] of [
    [1e20, 1e20, 60, 24], [60, 24, 60, 24], [10.9, 4.9, 10, 4], [1, 1, 1, 1],
  ]) {
    const lines = renderer.render(width, height, 1750, identity);
    assert.equal(lines.length, expectedHeight);
    for (const line of lines) assert.equal([...line].length, expectedWidth);
  }
});

test("all frames contain only occupied Braille plus plain spaces and fit viewport", () => {
  const renderer = createWatermarkRenderer();
  for (const [width, height] of [[60, 24], [33, 9], [8, 15], [2, 1]]) {
    for (const elapsed of [null, 0, 400, 1175, 1800, 2700, 3600, 5400, 7200]) {
      const lines = renderer.render(width, height, elapsed, identity);
      assert.equal(lines.length, height);
      for (const line of lines) {
        assert.match(line, /^[ \u2801-\u28ff]*$/u);
        assert.equal([...line].length, width);
      }
    }
  }
});

test("caller owns style; occupied adjacent equal-shade cells are painted in runs", () => {
  const renderer = createWatermarkRenderer();
  const calls: { text: string; shade: number }[] = [];
  const styled = renderer.render(48, 20, null, (text, shade) => {
    calls.push({ text, shade });
    return `\u001b[32m${text}\u001b[0m`;
  });
  const plain = renderer.render(48, 20, null, identity);
  assert.deepEqual(styled.map(stripAnsi), plain);
  assert.ok(calls.length > 0);
  const occupied = plain.join("").replaceAll(" ", "").length;
  assert.ok(calls.length < occupied / 2, "not one paint call per cell/dot");
  assert.equal(calls.reduce((count, call) => count + call.text.length, 0), occupied);
  for (const call of calls) {
    assert.match(call.text, /^[\u2801-\u28ff]+$/u);
    assert.ok(call.shade >= 0 && call.shade <= 1);
    assert.ok(Math.abs(call.shade * 7 - Math.round(call.shade * 7)) < 1e-10);
  }
  for (const line of styled) assert.equal(stripAnsi(line).length, 48);
  let callIndex = 0;
  for (const line of plain) {
    let x = 0;
    let previousShade: number | null = null;
    while (x < line.length) {
      if (line[x] === " ") {
        previousShade = null;
        x++;
        continue;
      }
      const call = calls[callIndex++];
      assert.equal(line.slice(x, x + call.text.length), call.text);
      if (previousShade !== null) assert.notEqual(call.shade, previousShade, "maximal adjacent shade runs");
      previousShade = call.shade;
      x += call.text.length;
    }
  }
  assert.equal(callIndex, calls.length);
});

test("renderers share no mutable geometry, frame, or caller paint state", () => {
  const first = createWatermarkRenderer();
  const second = createWatermarkRenderer();
  const idle = second.render(48, 20, null, identity);
  const badge = second.render(48, 20, 3600, identity);
  first.render(4, 2, 1200, (text) => `\u001b[31m${text}\u001b[0m`);
  first.render(60, 24, 5900, identity);
  assert.deepEqual(second.render(48, 20, null, identity), idle);
  assert.deepEqual(first.render(48, 20, null, identity), idle);
  assert.deepEqual(first.render(48, 20, 3600, identity), badge);
});
