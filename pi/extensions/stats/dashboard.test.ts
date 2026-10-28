import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeArg, PiStatsDashboard, type DashboardTheme } from "./dashboard.ts";
import { parseSessionText, type StatsCache } from "./stats.ts";

const theme: DashboardTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function session(path: string, timestamp: string, model: string, input: number, output: number, cacheRead: number, cost: number) {
  const raw = [
    JSON.stringify({ type: "session", id: path, timestamp, cwd: `/work/${path}` }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        provider: "test-provider",
        model,
        timestamp: Date.parse(timestamp),
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite: 0,
          totalTokens: input + output + cacheRead,
          cost: { total: cost },
        },
      },
    }),
  ].join("\n");
  return parseSessionText(raw, `/sessions/${path}.jsonl`);
}

function makeCache(sessions: ReturnType<typeof session>[]): StatsCache {
  return {
    version: 2,
    files: Object.fromEntries(sessions.map((item, index) => [item.sessionPath, {
      path: item.sessionPath,
      mtimeMs: index + 1,
      size: 100,
      parsedAt: 0,
      session: item,
    }])),
  };
}

function cache(): StatsCache {
  return makeCache([
    session("previous", "2026-06-03T10:00:00.000Z", "model-a", 100, 50, 50, 0.02),
    session("current-a", "2026-06-10T10:00:00.000Z", "model-a", 300, 100, 300, 0.08),
    session("current-b", "2026-06-11T10:00:00.000Z", "model-b", 100, 50, 0, 0.02),
  ]);
}

function dashboard(width = 100, args = "2026-06-08..2026-06-14", data = cache()) {
  let closed = false;
  const instance = new PiStatsDashboard({
    cache: data,
    args,
    done: () => { closed = true; },
    theme,
    refresh: "indexed 3 files (3 parsed, 0 cached)",
  });
  return { instance, lines: instance.render(width), closed: () => closed };
}

test("overview renders actionable comparisons within the requested width", () => {
  const { lines } = dashboard(100);
  const output = lines.join("\n");

  assert.match(output, /^stats /);
  assert.doesNotMatch(output, /pi-stats/);
  assert.match(output, /FRESH TOKENS/);
  assert.match(output, /CACHE LEVERAGE/);
  assert.match(output, /COST \/ 1M FRESH/);
  assert.match(output, /vs previous period/);
  assert.match(output, /DECISION SIGNALS/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("overview reflows instead of cropping at narrow widths", () => {
  const { lines } = dashboard(42);
  const output = lines.join("\n");

  assert.match(output, /FRESH TOKENS/);
  assert.match(output, /COST \/ 1M FRESH/);
  assert.match(output, /DECISION SIGNALS/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
});

test("activity uses a heatmap and pulse split on wide terminals", () => {
  const { lines } = dashboard(120, "2026-04-13..2026-07-11");
  const output = lines.join("\n");

  assert.match(output, /CALENDAR/);
  assert.match(output, /ACTIVITY PULSE/);
  assert.match(output, /Active days/);
  assert.match(output, /FRESH TOKEN TREND/);
  assert.match(output, /Apr/);
  assert.doesNotMatch(output, /AprMay|JunJ/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("activity stacks calendar and pulse on narrow terminals", () => {
  const { lines } = dashboard(42);
  const output = lines.join("\n");
  const calendarIndex = output.indexOf("CALENDAR");
  const pulseIndex = output.indexOf("ACTIVITY PULSE");

  assert.ok(calendarIndex >= 0);
  assert.ok(pulseIndex > calendarIndex);
  assert.match(output, /Busiest weekday/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
});

test("compares an in-progress range with the same elapsed prior window", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-06-10T12:00:00.000Z");
  try {
    const data = makeCache([
      session("prior-morning", "2026-06-09T10:00:00.000Z", "model-a", 100, 50, 0, 0.1),
      session("current-morning", "2026-06-10T10:00:00.000Z", "model-a", 100, 50, 0, 0.1),
    ]);
    const output = dashboard(100, "today", data).lines.join("\n");
    assert.match(output, /→ 0\.0% vs previous period/);
  } finally {
    Date.now = originalNow;
  }
});

test("concentration signal uses the fresh-token leader", () => {
  const data = makeCache([
    session("usage-leader", "2026-06-10T10:00:00.000Z", "usage-leader", 800, 100, 0, 0.01),
    session("cost-leader", "2026-06-10T11:00:00.000Z", "cost-leader", 90, 10, 0, 1),
  ]);
  const output = dashboard(100, "2026-06-10..2026-06-10", data).lines.join("\n");
  assert.match(output, /usage-leader carries 90% of fresh usage/);
  assert.doesNotMatch(output, /cost-leader carries/);
});

test("Kitty printable keys drive shortcuts and custom date entry", () => {
  const { instance, closed } = dashboard();
  instance.handleInput("\x1b[109u");
  assert.match(instance.render(100).join("\n"), /MODEL EFFICIENCY/);
  instance.handleInput("\x1b[111u");
  instance.handleInput("\x1b[100u");
  for (const character of "2026-06-01..2026-06-03") instance.handleInput(`\x1b[${character.codePointAt(0)}u`);
  assert.match(instance.render(100).join("\n"), /2026-06-01\.\.2026-06-03/);
  instance.handleInput("\x1b[113u");
  assert.equal(closed(), false, "q is typed into the active date field rather than closing it");
  instance.handleInput("\x1b");
  instance.handleInput("\x1b[113u");
  assert.equal(closed(), true);
});

test("normalizes numeric aliases and rejects impossible dates", () => {
  assert.equal(normalizeArg("7"), "7d");
  assert.equal(normalizeArg("30"), "30d");
  assert.equal(normalizeArg("90"), "90d");
  assert.equal(normalizeArg("2026-02-30..2026-03-05"), "30d");
});

test("all-time activity reports no current streak when activity is stale", () => {
  const data = makeCache([session("stale", "2020-01-01T10:00:00.000Z", "model-a", 100, 50, 0, 0.01)]);
  const output = dashboard(100, "all", data).lines.join("\n");
  assert.match(output, /0 current · 1 best/);
});

test("tables preserve their borders at minimum width", () => {
  const { instance } = dashboard(20);
  instance.handleInput("m");
  const tableLines = instance.render(20).filter((line) => /^[╭├│╰]/.test(line));
  assert.ok(tableLines.length > 3);
  assert.ok(tableLines.every((line) => /[╮┤│╯]$/.test(line)));
});

test("models support keyboard selection and drill-down", () => {
  const { instance } = dashboard();
  instance.handleInput("m");
  let output = instance.render(100).join("\n");
  assert.match(output, /MODEL EFFICIENCY/);
  assert.match(output, /›model-a/);

  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  output = instance.render(100).join("\n");
  assert.match(output, /MODEL INSPECTOR/);
  assert.match(output, /model-b via test-provider/);
  assert.match(output, /Decision/);
});

test("escape closes the dashboard", () => {
  const { instance, closed } = dashboard();
  instance.handleInput("\x1b");
  assert.equal(closed(), true);
});
