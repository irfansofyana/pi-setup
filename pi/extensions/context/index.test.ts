import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextExtension, { collectContextReport, ContextReportComponent, formatContextReport, registerContextCommand, type ContextReportSource } from "./index.ts";

function usage(totalTokens: number, cost = totalTokens / 1000) {
	return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: cost } };
}

function message(id: string, value: Record<string, unknown>) {
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: value };
}

function source(overrides: Partial<ContextReportSource> = {}): ContextReportSource {
	return {
		getContextUsage: () => ({ tokens: 800, contextWindow: 1000, percent: 80 }),
		model: { provider: "openai", id: "gpt-test", contextWindow: 1000 },
		sessionManager: {
			getEntries: () => [],
			buildContextEntries: () => [],
		},
		getSystemPromptOptions: () => ({ cwd: "/tmp", selectedTools: [] }),
		...overrides,
	};
}

test("registers exactly /context", () => {
	const commands: string[] = [];
	const pi = { registerCommand(name: string) { commands.push(name); } };
	contextExtension(pi as any);
	assert.deepEqual(commands, ["context"]);

	const second: string[] = [];
	registerContextCommand({ registerCommand(name: string) { second.push(name); } } as any);
	assert.deepEqual(second, ["context"]);
});

test("aggregates session-file usage across abandoned branches without double counting", () => {
	const assistantA = message("a", {
		role: "assistant", provider: "openai", model: "gpt-test", usage: usage(100),
		content: [{ type: "toolCall", name: "read", id: "call-a", arguments: {} }],
	});
	const toolA = message("ta", {
		role: "toolResult", toolName: "read", isError: false,
		content: [{ type: "text", text: "result" }], usage: usage(20),
	});
	const abandonedAssistant = message("b", { role: "assistant", provider: "anthropic", model: "claude-test", usage: usage(50), content: [] });
	const compaction = { type: "compaction", id: "c", parentId: null, summary: "summary", usage: usage(30) };
	const branchSummary = { type: "branch_summary", id: "s", parentId: null, fromId: "a", summary: "branch", usage: usage(40) };
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [assistantA, toolA, abandonedAssistant, compaction, branchSummary],
			buildContextEntries: () => [assistantA, toolA],
		},
	}));

	assert.equal(report.sessionUsage.totalTokens, 240);
	assert.equal(report.sessionUsage.input, 240);
	assert.equal(report.activeBranchUsage.totalTokens, 120);
	assert.equal(report.context.freeTokens, 200);
	assert.equal(report.flags.contextPressure.status, "watch");
	assert.equal(report.usageSources.assistant, 2);
	assert.equal(report.usageSources.toolResult, 1);
	assert.equal(report.usageSources.compaction, 1);
	assert.equal(report.usageSources.branchSummary, 1);
	assert.equal(report.branch.sessionEntries, 5);
	assert.equal(report.branch.activeEntries, 2);
	assert.equal(report.branch.sessionCompactions, 1);
	assert.equal(report.branch.activeCompactions, 0);
});

test("reports context unknown after compaction and preserves window", () => {
	const report = collectContextReport(source({
		getContextUsage: () => undefined,
		model: { contextWindow: 128000 },
	}));
	assert.equal(report.context.tokens, null);
	assert.equal(report.context.contextWindow, 128000);
	assert.equal(report.context.percent, null);
	assert.equal(report.context.freeTokens, null);
	assert.equal(report.context.unknown, true);
	assert.equal(report.flags.contextPressure.status, "unknown");
	assert.match(formatContextReport(report), /unknown after compaction/);
});

test("groups provider-model facts and summarizes tool results, errors, and exclusions", () => {
	const huge = "x".repeat(20_001);
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("a", { role: "assistant", provider: "p1", model: "m1", usage: usage(10), content: [{ type: "toolCall", name: "bash", id: "1", arguments: {} }] }),
				message("r", { role: "toolResult", toolName: "bash", isError: true, excludeFromContext: true, content: [{ type: "text", text: huge }] }),
				message("b", { role: "assistant", provider: "p2", model: "m2", usage: usage(20), content: [] }),
			],
			buildContextEntries: () => [],
		},
	}));
	assert.deepEqual(report.models.map((model) => `${model.provider}/${model.model}`), ["p1/m1", "p2/m2"]);
	assert.equal(report.turns.length, 2);
	assert.equal(report.turns[0]?.toolCalls, 1);
	assert.equal(report.turns[0]?.toolResults, 1);
	assert.equal(report.tools[0]?.errors, 1);
	assert.equal(report.tools[0]?.excludedFromContext, 1);
	assert.equal(report.tools[0]?.largestResultChars, 20_001);
	assert.equal(report.flags.toolBloat.status, "critical");
});

test("estimates active context content while omitting excluded bash output", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [],
			buildContextEntries: () => [
				message("a", { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }] }),
				{ type: "custom_message", id: "custom", content: [{ type: "text", text: "extension context" }] },
				message("b", { role: "bashExecution", command: "cat secret", output: "must not count", excludeFromContext: true }),
			],
		},
	}));
	assert.ok(report.activeEstimate.chars >= "[toolCall read] {\"path\":\"src/index.ts\"}".length + "extension context".length);
	assert.equal(report.activeEstimate.chars, "[toolCall read] {\"path\":\"src/index.ts\"}".length + "extension context".length);
});

test("estimates prompt contributors without exposing raw content and raises transparent flags", () => {
	const report = collectContextReport(source({
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		getSystemPromptOptions: () => ({
			cwd: "/tmp",
			customPrompt: "secret prompt that must not be printed".repeat(20),
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "read snippet" },
			promptGuidelines: ["guideline"],
			appendSystemPrompt: "append",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "private context" }],
			skills: [{ name: "skill-name", description: "skill description" }],
		}),
	}));
	assert.equal(report.prompt.selectedTools.count, 2);
	assert.equal(report.prompt.contextFiles.count, 1);
	assert.ok(report.prompt.totalChars > 0);
	assert.equal(report.flags.promptOverhead.status, "watch");
	const formatted = formatContextReport(report);
	assert.match(formatted, /raw content intentionally omitted/);
	assert.equal(formatted.includes("secret prompt that must not be printed"), false);
});

test("TUI uses custom scrollable report and closes on Ctrl-C", async () => {
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	registerContextCommand({ registerCommand(_name: string, value: any) { command = value; } } as any);
	let component: ContextReportComponent | undefined;
	let closed = false;
	await command!.handler("", {
		mode: "tui",
		...source(),
		ui: {
			custom(factory: any) {
				component = factory({}, { fg: (_name: string, value: string) => value }, {}, () => { closed = true; });
				component!.handleInput!("\x03");
				return Promise.resolve(undefined);
			},
		},
	});
	assert.ok(component);
	assert.equal(closed, true);
});

test("falls back to readable console text outside TUI and does not append a message", async () => {
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	registerContextCommand({ registerCommand(_name: string, value: any) { command = value; } } as any);
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (value?: unknown) => output.push(String(value));
	try {
		await command!.handler("", {
			mode: "print",
			...source(),
			ui: { custom() { throw new Error("TUI must not be used"); } },
		});
	} finally {
		console.log = originalLog;
	}
	assert.equal(output.length, 1);
	assert.match(output[0]!, /active-session diagnostics/);
});

test("uses protocol-safe output paths outside TUI", async () => {
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	registerContextCommand({ registerCommand(_name: string, value: any) { command = value; } } as any);
	const notices: string[] = [];
	await command!.handler("", {
		mode: "rpc",
		...source(),
		ui: { notify(value: string) { notices.push(value); } },
	});
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /active-session diagnostics/);

	const errors: string[] = [];
	const originalError = console.error;
	console.error = (value?: unknown) => errors.push(String(value));
	try {
		await command!.handler("", { mode: "json", ...source(), ui: {} });
	} finally {
		console.error = originalError;
	}
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /active-session diagnostics/);
});

test("preserves sub-cent cost totals instead of collapsing them to one decimal", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [message("a", { role: "assistant", provider: "openai", model: "m", usage: usage(34), content: [] })],
			buildContextEntries: () => [],
		},
	}));
	const formatted = formatContextReport(report);
	assert.match(formatted, /cost\.total=0\.034/);
	assert.doesNotMatch(formatted, /cost\.total=0\.0(?!\d)/);
});

test("wraps long lines to the terminal width instead of discarding their tails", () => {
	const theme = { fg: (_name: string, value: string) => `\x1b[33m${value}\x1b[0m` };
	const header = "/context — active-session diagnostics (read-only)";
	const long = "field=value ".repeat(20);
	const component = new ContextReportComponent(`${header}\n${long}`, () => {}, theme as any, { height: 32 });
	const lines = component.render(16);
	for (const rendered of lines) {
		assert.ok(visibleWidth(rendered) <= 16, `line visible width ${visibleWidth(rendered)} exceeds 16`);
	}
	const plain = lines.map((rendered) => rendered.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")).join("");
	assert.ok(plain.includes("diagnostics"), "themed header content preserved");
	assert.ok(plain.includes("field=value"), "wrapped tail content preserved");
});

test("does not attribute standalone shell output to the prior assistant turn", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("a", { role: "assistant", provider: "openai", model: "m", usage: usage(10), content: [{ type: "toolCall", name: "read", id: "1", arguments: {} }] }),
				message("r", { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] }),
				message("b", { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 }),
			],
			buildContextEntries: () => [],
		},
	}));
	assert.equal(report.turns.length, 1);
	assert.equal(report.turns[0]?.toolCalls, 1);
	assert.equal(report.turns[0]?.toolResults, 1, "standalone shell output must not count as the assistant's tool result");
	const bash = report.tools.find((tool) => tool.name === "bash");
	assert.equal(bash?.largestResultChars, 6, "user shell size accounts for command and output");
});

test("marks prompt contributors unavailable instead of fabricating zero-sized data", () => {
	const report = collectContextReport(source({
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		getSystemPromptOptions: () => { throw new Error("not exposed in this context"); },
	}));
	assert.equal(report.prompt.unavailable, true);
	assert.equal(report.prompt.selectedTools.count, 0);
	assert.equal(report.flags.promptOverhead.status, "unknown");
	assert.match(formatContextReport(report), /Prompt contributors: unavailable/);
});
