import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  COST_ICON,
  COST_WIDGET_EVENT,
  COST_WIDGET_ID,
  CostFooterController,
  formatSubagentCost,
  footerUsage,
  hasExternalFooter,
  installCostFooter,
} from "../src/ui/cost-footer.ts";

const usage: Usage = {
  input: 100,
  output: 50,
  cacheRead: 30,
  cacheWrite: 20,
  totalTokens: 200,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};
const message: AssistantMessage = {
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "test",
  content: [{ type: "text", text: "Done" }],
  stopReason: "stop",
  timestamp: 1,
  usage,
};

test("footer native usage includes caches, tool results, usage entries and compaction across branches", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage(message);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "t",
    toolName: "test",
    content: [{ type: "text", text: "Result" }],
    isError: false,
    timestamp: 1,
    usage,
  });
  manager.appendUsage("test", "test", "test-model", usage);
  manager.appendCompaction("summary", first, 200, undefined, false, usage);
  manager.branch(first);
  const totals = footerUsage(manager.getEntries());
  assert.equal(totals.input, 400);
  assert.equal(totals.cacheRead, 120);
  assert.equal(totals.cacheWrite, 80);
  assert.equal(totals.cost, 1.32);
  assert.equal(totals.cacheHit, 20);
});

test("footer shows combined dollars once and refreshes after settlement, preserving stats/statuses", () => {
  const manager = SessionManager.inMemory("/tmp/test");
  manager.appendMessage(message);
  let childCost = 0.5;
  let rendered = 0;
  let disposed = false;
  let component: { render(width: number): string[]; dispose?(): void; invalidate(): void };
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp/test",
    sessionManager: manager,
    model: { id: "test-model", provider: "test", reasoning: true },
    thinkingLevel: "high",
    getContextUsage: () => ({ percent: 5, contextWindow: 100000 }),
    ui: {
      setFooter(factory: any) {
        component = factory(
          { requestRender: () => rendered++ },
          { fg: (_: string, text: string) => text },
          {
            onBranchChange: () => () => {
              disposed = true;
            },
            getGitBranch: () => "main",
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => new Map([["agents", "2 agents"]]),
          },
        );
      },
    },
  } as unknown as ExtensionContext;
  const refresh = installCostFooter(ctx, () => childCost);
  const lines = component!.render(100);
  assert.match(lines[0], /test \(main\)/);
  assert.match(lines[1], /↑100 ↓50 R30 W20 CH20\.0% \$0\.830/);
  assert.match(lines[1], /5\.0%\/100k.*test-model • high/);
  assert.equal(lines[2], "2 agents");
  childCost = 0.7;
  refresh!();
  assert.equal(rendered, 1);
  assert.match(component!.render(100)[1], /\$1\.030/);
  manager.appendMessage(message);
  assert.match(component!.render(100)[1], /\$1\.360/);
  for (const width of [1, 10, 40, 100]) {
    assert.ok(component!.render(width).every((line) => visibleWidth(line) <= width));
  }
  component!.dispose!();
  assert.equal(disposed, true);
});

test("external footer receives only its cost slot; never install or clear its footer", () => {
  const published: unknown[] = [];
  let cost = 0;
  let nerdFont = false;
  const publisher = {
    getCommands: () => [{ name: "footer", source: "extension" }],
    events: {
      emit: (event: string, payload: unknown) => {
        assert.equal(event, COST_WIDGET_EVENT);
        published.push(payload);
      },
    },
  } as unknown as ConstructorParameters<typeof CostFooterController>[0];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setFooter() {
        assert.fail("pi-footer must retain exclusive footer ownership");
      },
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController(
    publisher,
    () => cost,
    () => nerdFont,
    () => "pi-footer-event",
  );
  footer.refresh(ctx);
  cost = 0.5;
  footer.refresh(ctx);
  cost = 0.8;
  nerdFont = true;
  footer.refresh(ctx);
  footer.reset(ctx);
  footer.refresh(ctx);
  footer.clear();
  assert.deepEqual(published, [
    { widgetId: COST_WIDGET_ID, value: "$0.0000" },
    { widgetId: COST_WIDGET_ID, value: "$0.5000" },
    { widgetId: COST_WIDGET_ID, value: COST_ICON + " $0.8000" },
    { widgetId: COST_WIDGET_ID, value: COST_ICON + " $0.8000" },
    { widgetId: COST_WIDGET_ID, value: null },
  ]);
});

test("without a footer extension, install fallback only once cost exists and reset between sessions", () => {
  let cost = 0;
  const installed: unknown[] = [];
  const published: unknown[] = [];
  const publisher = {
    getCommands: () => [],
    events: { emit: (_: string, payload: unknown) => published.push(payload) },
  } as unknown as ConstructorParameters<typeof CostFooterController>[0];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setFooter: (factory: unknown) => installed.push(factory),
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController(
    publisher,
    () => cost,
    () => false,
    () => "pi-footer-event",
  );
  footer.refresh(ctx);
  assert.equal(installed.length, 0);
  cost = 0.5;
  footer.refresh(ctx);
  footer.refresh(ctx);
  assert.equal(installed.length, 1);
  assert.equal(typeof installed[0], "function");
  footer.reset(ctx);
  assert.equal(installed[1], undefined);
  cost = 0;
  footer.refresh(ctx);
  assert.equal(installed.length, 2);
  assert.deepEqual(published.at(-1), { widgetId: COST_WIDGET_ID, value: "$0.0000" });
});

test("prompt/skill named footer cannot claim the footer; loaded extension command can", () => {
  const pi = (source: string) =>
    ({ getCommands: () => [{ name: "footer", source }] }) as unknown as Parameters<
      typeof hasExternalFooter
    >[0];
  assert.equal(hasExternalFooter(pi("prompt")), false);
  assert.equal(hasExternalFooter(pi("skill")), false);
  assert.equal(hasExternalFooter(pi("extension")), true);
  assert.equal(formatSubagentCost(0.012345, false), "$0.0123");
  assert.equal(formatSubagentCost(0.012345, true), COST_ICON + " $0.0123");
});

test("an external footer taking ownership is never cleared by a previous fallback owner", () => {
  let external = false;
  let setCalls = 0;
  const publisher = {
    getCommands: () => (external ? [{ name: "footer", source: "extension" }] : []),
    events: { emit() {} },
  } as unknown as ConstructorParameters<typeof CostFooterController>[0];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setFooter() {
        setCalls++;
      },
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController(
    publisher,
    () => 0.5,
    () => false,
    () => "pi-footer-event",
  );
  footer.refresh(ctx);
  assert.equal(setCalls, 1);
  external = true;
  footer.reset(ctx);
  footer.refresh(ctx);
  assert.equal(setCalls, 1);
});


test("status-key mode registers zero cost for discovery and Pi status mode is labeled", () => {
  const statuses = new Map<string, string>();
  let cost = 0;
  const manager = SessionManager.inMemory();
  manager.appendMessage(message);
  let mode: "pi-footer-status" | "pi-status" = "pi-footer-status";
  const ctx = {
    hasUI: true, mode: "tui",
    sessionManager: manager,
    ui: {
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter() { assert.fail("status modes must not replace Pi’s footer"); },
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController({
    getCommands: () => [],
    events: { emit() { assert.fail("status modes must not emit pi-footer events"); } },
  } as any, () => cost, () => false, () => mode);
  footer.refresh(ctx);
  assert.equal(statuses.get(COST_WIDGET_ID), "$0.0000");
  cost = 0.5;
  footer.refresh(ctx);
  assert.equal(statuses.get(COST_WIDGET_ID), "$0.5000");
  mode = "pi-status";
  footer.refresh(ctx);
  assert.equal(statuses.get(COST_WIDGET_ID), "Total: $0.8300");
  footer.reset(ctx);
  cost = 0;
  footer.refresh(ctx);
  assert.equal(statuses.get(COST_WIDGET_ID), "Total: $0.3300");
  footer.clear();
  assert.equal(statuses.has(COST_WIDGET_ID), false);
});

test("switching transports clears old values and removes only our own fallback footer", () => {
  const statuses = new Map<string, string>();
  const updates: unknown[] = [];
  const footers: unknown[] = [];
  let mode: "pi-footer-event" | "pi-footer-status" = "pi-footer-event";
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter(factory: unknown) { footers.push(factory); },
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController({
    getCommands: () => [],
    events: { emit: (_: string, payload: unknown) => updates.push(payload) },
  } as any, () => 0.5, () => false, () => mode);
  footer.refresh(ctx);
  assert.equal(typeof footers[0], "function");
  mode = "pi-footer-status";
  footer.refresh(ctx);
  assert.equal(footers[1], undefined);
  assert.deepEqual(updates.at(-1), { widgetId: COST_WIDGET_ID, value: null });
  assert.equal(statuses.get(COST_WIDGET_ID), "$0.5000");
  mode = "pi-footer-event";
  footer.refresh(ctx);
  assert.equal(statuses.has(COST_WIDGET_ID), false);
  assert.deepEqual(updates.at(-1), { widgetId: COST_WIDGET_ID, value: "$0.5000" });
  footer.clear();
  assert.deepEqual(updates.at(-1), { widgetId: COST_WIDGET_ID, value: null });
});

