import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextExtension, { collectContextReport, ContextReportComponent, formatContextReport, formatDashboard, registerContextCommand, type ContextReportSource } from "./index.ts";

function usage(totalTokens: number, cost = totalTokens / 1000) {
	return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: cost } };
}

function message(id: string, value: Record<string, unknown>) {
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: value };
}

function source(overrides: Partial<ContextReportSource> = {}): ContextReportSource {
	return {
		model: { provider: "openai", id: "gpt-test", contextWindow: 1000 },
		sessionManager: {
			getEntries: () => [],
			buildContextEntries: () => [],
		},
		getSystemPromptOptions: () => ({ cwd: "/tmp", selectedTools: [] }),
		getSystemPrompt: () => "You are a test assistant. Be concise.",
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
	assert.equal(report.usageSources.assistant, 2);
	assert.equal(report.usageSources.toolResult, 1);
	assert.equal(report.usageSources.compaction, 1);
	assert.equal(report.usageSources.branchSummary, 1);
	assert.equal(report.branch.sessionEntries, 5);
	assert.equal(report.branch.activeEntries, 2);
	assert.equal(report.branch.sessionCompactions, 1);
	assert.equal(report.branch.activeCompactions, 0);
	assert.equal(report.lastPrompt.unknown, false);
	assert.equal(report.lastPrompt.input, 100);
	assert.equal(report.lastPrompt.percent, 10);
});

test("reports last prompt unknown when no assistant has reported usage and preserves window", () => {
	const report = collectContextReport(source({ model: { contextWindow: 128000 } }));
	assert.equal(report.lastPrompt.unknown, true);
	assert.equal(report.lastPrompt.contextWindow, 128000);
	assert.equal(report.lastPrompt.percent, null);
	assert.match(formatContextReport(report), /no completed assistant turn with reported usage yet/);
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
	assert.equal(report.toolBloat.status, "critical");
});

test("counts active-branch messages including custom messages without token estimation", () => {
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
	assert.equal(report.branch.activeMessages, 3);
	assert.equal(report.branch.activeEntries, 3);
	// No token estimate is exposed anywhere in the report.
	assert.equal("estimatedTokens" in report, false);
});

test("measures prompt contributors without exposing raw content or estimating tokens", () => {
	const report = collectContextReport(source({
		getSystemPrompt: () => "x".repeat(400),
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
	assert.equal(report.systemPrompt.chars, 400);
	assert.equal(report.systemPrompt.available, true);
	const formatted = formatContextReport(report);
	assert.match(formatted, /measured, not tokenized/);
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
			ui: { custom() { throw new Error("TUI must not be used"); } } },
		);
	} finally {
		console.log = originalLog;
	}
	assert.equal(output.length, 1);
	assert.match(output[0]!, /session facts/);
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
	assert.match(notices[0]!, /session facts/);

	const errors: string[] = [];
	const originalError = console.error;
	console.error = (value?: unknown) => errors.push(String(value));
	try {
		await command!.handler("", { mode: "json", ...source(), ui: {} });
	} finally {
		console.error = originalError;
	}
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /session facts/);
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

test("wraps report lines to the terminal width without overflowing", () => {
	const theme = { fg: (_name: string, value: string) => `\x1b[33m${value}\x1b[0m` };
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("a", { role: "assistant", provider: "openai", model: "a-very-long-model-name-that-wraps", usage: usage(10), content: [] }),
			],
			buildContextEntries: () => [],
		},
	}));
	const component = new ContextReportComponent(report, () => {}, theme as any, { height: 32 });
	for (const width of [10, 16, 24, 40]) {
		for (const rendered of component.render(width)) {
			assert.ok(visibleWidth(rendered) <= width, `width ${width}: line visible width ${visibleWidth(rendered)} exceeds ${width}`);
		}
	}
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
		getSystemPromptOptions: () => { throw new Error("not exposed in this context"); },
	}));
	assert.equal(report.prompt.unavailable, true);
	assert.equal(report.prompt.selectedTools.count, 0);
	assert.match(formatContextReport(report), /Prompt contributors: unavailable/);
});

test("marks the assembled system prompt unavailable when it cannot be read", () => {
	const report = collectContextReport(source({
		getSystemPrompt: () => { throw new Error("not exposed"); },
	}));
	assert.equal(report.systemPrompt.available, false);
	assert.equal(report.systemPrompt.chars, 0);
});

test("counts explicitly invoked skills from <skill> blocks in user messages", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("u1", { role: "user", content: [{ type: "text", text: '<skill name="research" location="/x">\nbody\n</skill>\n\nfind foo' }] }),
				message("a1", { role: "assistant", provider: "openai", model: "m", usage: usage(10), content: [] }),
				message("u2", { role: "user", content: [{ type: "text", text: '<skill name="research" location="/x">\nbody\n</skill>' }] }),
				message("u3", { role: "user", content: [{ type: "text", text: '<skill name="code-review" location="/y">\nbody\n</skill>' }] }),
			],
			buildContextEntries: () => [],
		},
	}));
	assert.deepEqual(report.skills, [
		{ name: "research", invocations: 2 },
		{ name: "code-review", invocations: 1 },
	]);
});

test("does not count malformed skill tags as invocations", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("u1", { role: "user", content: [{ type: "text", text: '<skill name="not-a-real-block" just some prose' }] }),
				message("a1", { role: "assistant", provider: "openai", model: "m", usage: usage(10), content: [] }),
			],
			buildContextEntries: () => [],
		},
	}));
	assert.deepEqual(report.skills, []);
});

test("dashboard surfaces the last-prompt bar, spend, tools, and skills without any estimate", () => {
	const assistant = message("a", { role: "assistant", provider: "openai", model: "gpt-test", usage: usage(800), content: [] });
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("u", { role: "user", content: [{ type: "text", text: '<skill name="research" location="/x">\nbody\n</skill>' }] }),
				assistant,
			],
			buildContextEntries: () => [assistant],
		},
	}));
	const dashboard = formatDashboard(report);
	assert.match(dashboard, /session facts/);
	assert.match(dashboard, /last prompt/);
	assert.match(dashboard, /▓/);
	assert.match(dashboard, /prompt tokens/);
	assert.match(dashboard, /skills research ×1/);
	assert.match(dashboard, /spend in /);
	assert.doesNotMatch(dashboard, /chars÷4/);
	assert.doesNotMatch(dashboard, /estimated/);
});

test("counts cached tokens toward the prompt ratio instead of understating it", () => {
	const cached = message("a", {
		role: "assistant", provider: "openai", model: "gpt-test",
		usage: { input: 100, output: 10, cacheRead: 700, cacheWrite: 0, totalTokens: 810, cost: { total: 0 } },
		content: [],
	});
	const report = collectContextReport(source({
		sessionManager: { getEntries: () => [cached], buildContextEntries: () => [cached] },
	}));
	assert.equal(report.lastPrompt.promptTokens, 800);
	assert.equal(report.lastPrompt.percent, 80);
});

test("does not fall back to abandoned-branch usage for the last prompt", () => {
	const abandoned = message("b", { role: "assistant", provider: "openai", model: "gpt-test", usage: usage(50), content: [] });
	const report = collectContextReport(source({
		sessionManager: { getEntries: () => [abandoned], buildContextEntries: () => [] },
	}));
	assert.equal(report.lastPrompt.unknown, true);
});

test("omits the prompt percent when the last turn ran a different model", () => {
	const other = message("a", { role: "assistant", provider: "anthropic", model: "claude-test", usage: usage(100), content: [] });
	const report = collectContextReport(source({
		model: { provider: "openai", id: "gpt-test", contextWindow: 1000 },
		sessionManager: { getEntries: () => [other], buildContextEntries: () => [other] },
	}));
	assert.equal(report.lastPrompt.percent, null);
	assert.match(report.lastPrompt.note ?? "", /differs from current model/);
});

test("tool bloat shows the aggregate that triggered, not just the largest result", () => {
	const entries = Array.from({ length: 6 }, (_, i) =>
		message(`t${i}`, { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(9_000) }] }),
	);
	const report = collectContextReport(source({
		sessionManager: { getEntries: () => entries, buildContextEntries: () => [] },
	}));
	assert.equal(report.toolBloat.status, "critical");
	assert.equal(report.toolBloat.observedChars, 54_000);
	assert.equal(report.toolBloat.largestChars, 9_000);
	assert.match(formatDashboard(report), /aggregate 54,000 chars \(limit 50,000\)/);
	assert.doesNotMatch(formatDashboard(report), /largest 9,000/);
});

test("tool bloat warning names the trigger that fired", () => {
	const singleHuge = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("r", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(20_001) }] }),
			],
			buildContextEntries: () => [],
		},
	}));
	const dashboard = formatDashboard(singleHuge);
	assert.equal(singleHuge.toolBloat.status, "critical");
	assert.match(dashboard, /largest 20,001 chars \(limit 20,000\)/);
	assert.doesNotMatch(dashboard, /aggregate 20,001/);
});

test("tool bloat reports both triggers when both thresholds fire", () => {
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("r", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(21_000) }] }),
				message("s", { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "y".repeat(30_000) }] }),
			],
			buildContextEntries: () => [],
		},
	}));
	const dashboard = formatDashboard(report);
	assert.match(dashboard, /aggregate 51,000 chars \(limit 50,000\)/);
	assert.match(dashboard, /largest 30,000 chars \(limit 20,000\)/);
});

test("labels fork points as branch points, not branches", () => {
	const fork = [
		{ type: "custom_message", id: "root", parentId: null },
		{ type: "custom_message", id: "x", parentId: "root" },
		{ type: "custom_message", id: "y", parentId: "root" },
		{ type: "custom_message", id: "z", parentId: "root" },
	];
	const report = collectContextReport(source({
		sessionManager: { getEntries: () => fork, buildContextEntries: () => [] },
	}));
	assert.equal(report.branch.branchPoints, 1);
	assert.match(formatDashboard(report), /branch points/);
	assert.doesNotMatch(formatDashboard(report), /\d+ branches/);
});

test("measures image payload bytes in tool results instead of a placeholder", () => {
	const imgData = "x".repeat(1_000);
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("a", { role: "assistant", provider: "openai", model: "gpt-test", usage: usage(10), content: [{ type: "toolCall", name: "screenshot", id: "1", arguments: {} }] }),
				message("r", { role: "toolResult", toolName: "screenshot", content: [{ type: "image", data: imgData, mimeType: "image/png" }] }),
			],
			buildContextEntries: () => [],
		},
	}));
	const tool = report.tools.find((t) => t.name === "screenshot");
	assert.ok(tool);
	assert.equal(tool?.resultChars, 1_000);
	assert.equal(tool?.resultBytes, 1_000);
});

test("toggles between dashboard and details on [d]", () => {
	const theme = { fg: (_name: string, value: string) => value };
	const report = collectContextReport(source());
	const component = new ContextReportComponent(report, () => {}, theme as any, { height: 32 });
	assert.match(component.render(80).join("\n"), /session facts/);
	assert.doesNotMatch(component.render(80).join("\n"), /Spend \(exact provider-reported usage/);
	component.handleInput("d");
	assert.match(component.render(80).join("\n"), /Spend \(exact provider-reported usage/);
	component.handleInput("d");
	assert.doesNotMatch(component.render(80).join("\n"), /Spend \(exact provider-reported usage/);
});

test("frames the report in a bordered panel on wide terminals", () => {
	const bgCalls: string[] = [];
	const theme = {
		fg: (_name: string, value: string) => value,
		bg: (name: string, value: string) => {
			bgCalls.push(name);
			return value;
		},
	};
	const report = collectContextReport(source());
	const component = new ContextReportComponent(report, () => {}, theme as any, { height: 32 });
	const lines = component.render(60);
	assert.match(lines[0]!, /^╭/);
	assert.match(lines[0]!, /╮$/);
	assert.match(lines[lines.length - 1]!, /^╰/);
	assert.match(lines[lines.length - 1]!, /╯$/);
	for (const line of lines.slice(1, -1)) assert.match(line, /^│.*│$/);
	for (const line of lines) assert.equal(visibleWidth(line), 60, `line must fill exactly 60 columns`);
	assert.ok(bgCalls.length > 0, "panel background applied via theme.bg");
	assert.ok(bgCalls.every((name) => name === "selectedBg"), "panel uses the raised-surface theme background");
});

test("falls back to plain lines on narrow terminals", () => {
	const theme = { fg: (_name: string, value: string) => value };
	const report = collectContextReport(source());
	const component = new ContextReportComponent(report, () => {}, theme as any, { height: 32 });
	for (const width of [10, 20, 30]) {
		const lines = component.render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.doesNotMatch(line, /[╭╮╰╯│]/);
			assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("fits the framed panel within short terminal heights", () => {
	const theme = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value };
	const report = collectContextReport(source());
	for (const height of [4, 8, 10, 11]) {
		const component = new ContextReportComponent(report, () => {}, theme as any, { height });
		const lines = component.render(60);
		const available = Math.floor(height * 0.86);
		assert.ok(lines.length <= available, `height ${height}: rendered ${lines.length} lines exceeds overlay cap ${available}`);
		assert.ok(lines.length >= 3, `height ${height}: framed panel must keep top/body/bottom borders`);
	}
});

test("scrolls with j/k and resets offset when toggling views", () => {
	const theme = { fg: (_name: string, value: string) => value };
	const report = collectContextReport(source({
		sessionManager: {
			getEntries: () => [
				message("a", { role: "assistant", provider: "openai", model: "gpt-test", usage: usage(10), content: [{ type: "toolCall", name: "read", id: "1", arguments: {} }] }),
				message("r", { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "result" }] }),
			],
			buildContextEntries: () => [],
		},
	}));
	const component = new ContextReportComponent(report, () => {}, theme as any, { height: 20 });
	const first = component.render(60).join("\n");
	component.handleInput("j");
	assert.notEqual(component.render(60).join("\n"), first);
	component.handleInput("k");
	assert.equal(component.render(60).join("\n"), first);
	component.handleInput("d");
	component.handleInput("j");
	component.handleInput("d");
	assert.equal(component.render(60).join("\n"), first, "toggling views resets scroll offset");
});
