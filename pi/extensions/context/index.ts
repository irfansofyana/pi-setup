import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, type Component } from "@earendil-works/pi-tui";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface ContextFlag {
	status: "clear" | "watch" | "critical" | "unknown";
	observed: number | null;
	threshold: string;
	note?: string;
}

export interface ToolSummary {
	name: string;
	calls: number;
	results: number;
	resultChars: number;
	resultBytes: number;
	errors: number;
	excludedFromContext: number;
	largeResults: number;
	largestResultChars: number;
}

export interface ModelSummary {
	provider: string;
	model: string;
	calls: number;
	usage: UsageTotals;
}

export interface TurnSummary {
	turn: number;
	provider: string;
	model: string;
	usage: UsageTotals;
	toolCalls: number;
	toolResults: number;
}

export interface PromptEstimate {
	customPrompt: { chars: number; bytes: number };
	selectedTools: { count: number; names: string[] };
	toolSnippets: { count: number; chars: number; bytes: number };
	guidelines: { count: number; chars: number; bytes: number };
	appendPrompt: { chars: number; bytes: number };
	contextFiles: { count: number; pathChars: number; contentChars: number; contentBytes: number };
	skills: { count: number; names: string[]; metadataChars: number; metadataBytes: number };
	totalChars: number;
	totalBytes: number;
	estimatedTokens: number;
}

export interface ContextReport {
	context: {
		tokens: number | null;
		contextWindow: number | null;
		percent: number | null;
		percentDerived: boolean;
		freeTokens: number | null;
		unknown: boolean;
	};
	sessionUsage: UsageTotals;
	activeBranchUsage: UsageTotals;
	usageSources: { assistant: number; toolResult: number; compaction: number; branchSummary: number };
	branch: {
		sessionEntries: number;
		activeEntries: number;
		sessionMessages: number;
		activeMessages: number;
		sessionCompactions: number;
		activeCompactions: number;
		sessionBranchSummaries: number;
		activeBranchSummaries: number;
		branchPoints: number;
	};
	models: ModelSummary[];
	turns: TurnSummary[];
	tools: ToolSummary[];
	prompt: PromptEstimate;
	activeEstimate: { entries: number; messages: number; chars: number; bytes: number; estimatedTokens: number };
	flags: { contextPressure: ContextFlag; promptOverhead: ContextFlag; toolBloat: ContextFlag };
}

export interface ContextReportSource {
	getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	model?: { contextWindow?: number; provider?: string; id?: string };
	sessionManager: {
		getEntries: () => unknown[];
		buildContextEntries: () => unknown[];
	};
	getSystemPromptOptions: () => {
		customPrompt?: string;
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		promptGuidelines?: string[];
		appendSystemPrompt?: string;
		contextFiles?: Array<{ path: string; content: string }>;
		skills?: Array<{ name: string; description: string }>;
	};
}

const ZERO_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
const LARGE_TOOL_RESULT_CHARS = 20_000;
const TOOL_BLOAT_CHARS = 50_000;
const PROMPT_OVERHEAD_PERCENT = 25;
const CONTEXT_WATCH_PERCENT = 70;
const CONTEXT_CRITICAL_PERCENT = 90;
const MAX_REPORT_LINES = 140;

function zeroUsage(): UsageTotals {
	return { ...ZERO_USAGE };
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageValue(value: unknown): UsageTotals {
	if (!value || typeof value !== "object") return zeroUsage();
	const raw = value as Record<string, unknown>;
	const cost = raw.cost && typeof raw.cost === "object" ? (raw.cost as Record<string, unknown>) : {};
	return {
		input: numberValue(raw.input),
		output: numberValue(raw.output),
		cacheRead: numberValue(raw.cacheRead),
		cacheWrite: numberValue(raw.cacheWrite),
		totalTokens: numberValue(raw.totalTokens),
		costTotal: numberValue(cost.total),
	};
}

export function addUsage(target: UsageTotals, value: unknown): void {
	const usage = usageValue(value);
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.costTotal += usage.costTotal;
}

function usageIsPresent(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some((item) => typeof item === "number"));
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : "";
		})
		.join("\n");
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function messageOf(entry: unknown): Record<string, unknown> | undefined {
	const record = recordOf(entry);
	return record?.type === "message" ? recordOf(record.message) : undefined;
}

function contentSize(value: unknown): { chars: number; bytes: number } {
	const text = textFromContent(value);
	return { chars: text.length, bytes: byteLength(text) };
}

function messageSize(message: Record<string, unknown>): { chars: number; bytes: number } {
	if (message.role === "bashExecution") return contentSize(`${String(message.command ?? "")}\n${String(message.output ?? "")}`);
	if (message.role === "compactionSummary" || message.role === "branchSummary") return contentSize(message.summary);
	return contentSize(message.content);
}

function excludedFromContext(message: Record<string, unknown>): boolean {
	const details = recordOf(message.details);
	return message.excludeFromContext === true || details?.excludeFromContext === true || details?.excludedFromContext === true;
}

function toolCalls(message: Record<string, unknown>): string[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((part) => {
		const record = recordOf(part);
		return record?.type === "toolCall" && typeof record.name === "string" ? [record.name] : [];
	});
}

function sumSizes(a: { chars: number; bytes: number }, b: { chars: number; bytes: number }) {
	return { chars: a.chars + b.chars, bytes: a.bytes + b.bytes };
}

function promptEstimate(options: ContextReportSource["getSystemPromptOptions"] extends () => infer T ? T : never): PromptEstimate {
	const customPrompt = contentSize(options.customPrompt);
	const snippets = Object.values(options.toolSnippets ?? {});
	const toolSnippets = snippets.reduce((size, value) => sumSizes(size, contentSize(value)), { chars: 0, bytes: 0 });
	const guidelines = (options.promptGuidelines ?? []).reduce((size, value) => sumSizes(size, contentSize(value)), { chars: 0, bytes: 0 });
	const appendPrompt = contentSize(options.appendSystemPrompt);
	const contextFiles = (options.contextFiles ?? []).reduce(
		(total, file) => ({
			count: total.count + 1,
			pathChars: total.pathChars + (typeof file.path === "string" ? file.path.length : 0),
			contentChars: total.contentChars + (typeof file.content === "string" ? file.content.length : 0),
			contentBytes: total.contentBytes + (typeof file.content === "string" ? byteLength(file.content) : 0),
		}),
		{ count: 0, pathChars: 0, contentChars: 0, contentBytes: 0 },
	);
	const skills = (options.skills ?? []).reduce(
		(total, skill) => {
			const metadata = `${skill.name ?? ""}\n${skill.description ?? ""}`;
			const size = contentSize(metadata);
			return {
				count: total.count + 1,
				names: total.names.concat(typeof skill.name === "string" ? [skill.name] : []),
				metadataChars: total.metadataChars + size.chars,
				metadataBytes: total.metadataBytes + size.bytes,
			};
		},
		{ count: 0, names: [] as string[], metadataChars: 0, metadataBytes: 0 },
	);
	const totalChars = customPrompt.chars + toolSnippets.chars + guidelines.chars + appendPrompt.chars + contextFiles.contentChars + skills.metadataChars;
	const totalBytes = customPrompt.bytes + toolSnippets.bytes + guidelines.bytes + appendPrompt.bytes + contextFiles.contentBytes + skills.metadataBytes;
	return {
		customPrompt,
		selectedTools: { count: (options.selectedTools ?? []).length, names: [...(options.selectedTools ?? [])] },
		toolSnippets: { count: snippets.length, ...toolSnippets },
		guidelines: { count: (options.promptGuidelines ?? []).length, ...guidelines },
		appendPrompt,
		contextFiles,
		skills,
		totalChars,
		totalBytes,
		estimatedTokens: Math.ceil(totalChars / 4),
	};
}

function safeEntries(getter: () => unknown[]): unknown[] {
	try {
		const entries = getter();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
}

function branchPoints(entries: unknown[]): number {
	const children = new Map<string, number>();
	for (const entry of entries) {
		const parentId = recordOf(entry)?.parentId;
		if (typeof parentId === "string") children.set(parentId, (children.get(parentId) ?? 0) + 1);
	}
	return [...children.values()].filter((count) => count > 1).length;
}

function contextPercent(usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined, model?: { contextWindow?: number }) {
	if (!usage) return { tokens: null, contextWindow: model?.contextWindow ?? null, percent: null, percentDerived: false, freeTokens: null, unknown: true };
	const contextWindow = numberValue(usage.contextWindow) || numberValue(model?.contextWindow) || null;
	const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
	const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
		? usage.percent
		: tokens !== null && contextWindow
			? (tokens / contextWindow) * 100
			: null;
	return {
		tokens,
		contextWindow,
		percent,
		percentDerived: usage.percent == null && percent !== null,
		freeTokens: tokens !== null && contextWindow !== null ? Math.max(0, contextWindow - tokens) : null,
		unknown: tokens === null,
	};
}

function contextFlag(context: ContextReport["context"]): ContextFlag {
	if (context.percent === null) return { status: "unknown", observed: null, threshold: ">70% watch; >90% critical", note: "Pi token estimate unavailable, commonly immediately after compaction" };
	return {
		status: context.percent > CONTEXT_CRITICAL_PERCENT ? "critical" : context.percent > CONTEXT_WATCH_PERCENT ? "watch" : "clear",
		observed: context.percent,
		threshold: ">70% watch; >90% critical",
	};
}

function modelKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

export function collectContextReport(ctx: ContextReportSource): ContextReport {
	const sessionEntries = safeEntries(() => ctx.sessionManager.getEntries());
	const activeEntries = safeEntries(() => ctx.sessionManager.buildContextEntries());
	const sessionUsage = zeroUsage();
	const activeBranchUsage = zeroUsage();
	const usageSources = { assistant: 0, toolResult: 0, compaction: 0, branchSummary: 0 };
	const models = new Map<string, ModelSummary>();
	const turns: TurnSummary[] = [];
	const toolMap = new Map<string, ToolSummary>();
	let currentTurn: TurnSummary | undefined;

	const processEntries = (entries: unknown[], targetUsage?: UsageTotals, collectFacts = false) => {
		for (const entry of entries) {
			const record = recordOf(entry);
			if (!record) continue;
			if (record.type === "compaction" && usageIsPresent(record.usage)) {
				if (targetUsage) addUsage(targetUsage, record.usage);
				if (collectFacts) usageSources.compaction++;
			}
			if (record.type === "branch_summary" && usageIsPresent(record.usage)) {
				if (targetUsage) addUsage(targetUsage, record.usage);
				if (collectFacts) usageSources.branchSummary++;
			}
			if (record.type !== "message") continue;
			const message = recordOf(record.message);
			if (!message) continue;
			if (message.role === "assistant") {
				if (usageIsPresent(message.usage) && targetUsage) addUsage(targetUsage, message.usage);
				if (!collectFacts) continue;
				if (usageIsPresent(message.usage)) usageSources.assistant++;
				const provider = typeof message.provider === "string" ? message.provider : "unknown-provider";
				const model = typeof message.model === "string" ? message.model : "unknown-model";
				const key = modelKey(provider, model);
				let summary = models.get(key);
				if (!summary) {
					summary = { provider, model, calls: 0, usage: zeroUsage() };
					models.set(key, summary);
				}
				summary.calls++;
				addUsage(summary.usage, message.usage);
				currentTurn = { turn: turns.length + 1, provider, model, usage: usageValue(message.usage), toolCalls: 0, toolResults: 0 };
				turns.push(currentTurn);
				for (const name of toolCalls(message)) {
					currentTurn.toolCalls++;
					const tool = toolMap.get(name) ?? { name, calls: 0, results: 0, resultChars: 0, resultBytes: 0, errors: 0, excludedFromContext: 0, largeResults: 0, largestResultChars: 0 };
					tool.calls++;
					toolMap.set(name, tool);
				}
			} else if (message.role === "toolResult") {
				if (usageIsPresent(message.usage)) {
					if (targetUsage) addUsage(targetUsage, message.usage);
					if (collectFacts) usageSources.toolResult++;
				}
				if (!collectFacts) continue;
				const name = typeof message.toolName === "string" ? message.toolName : "unknown-tool";
				const tool = toolMap.get(name) ?? { name, calls: 0, results: 0, resultChars: 0, resultBytes: 0, errors: 0, excludedFromContext: 0, largeResults: 0, largestResultChars: 0 };
				const size = contentSize(message.content);
				tool.results++;
				tool.resultChars += size.chars;
				tool.resultBytes += size.bytes;
				if (message.isError === true) tool.errors++;
				if (excludedFromContext(message)) tool.excludedFromContext++;
				if (size.chars > LARGE_TOOL_RESULT_CHARS) tool.largeResults++;
				tool.largestResultChars = Math.max(tool.largestResultChars, size.chars);
				if (currentTurn) currentTurn.toolResults++;
				toolMap.set(name, tool);
			}
		}
	};

	processEntries(sessionEntries, sessionUsage, true);
	// Tool results and summary usage are deliberately handled in the same single entry pass above.
	processEntries(activeEntries, activeBranchUsage, false);

	const activeEstimate = activeEntries.reduce(
		(total, entry) => {
			const message = messageOf(entry);
			const size = message ? messageSize(message) : contentSize(recordOf(entry)?.summary);
			return {
				entries: total.entries + 1,
				messages: total.messages + (message ? 1 : 0),
				chars: total.chars + size.chars,
				bytes: total.bytes + size.bytes,
			};
		},
		{ entries: 0, messages: 0, chars: 0, bytes: 0 },
	);
	const context = contextPercent(ctx.getContextUsage(), ctx.model);
	let options: ReturnType<typeof promptEstimate>;
	try {
		options = promptEstimate(ctx.getSystemPromptOptions());
	} catch {
		options = promptEstimate({ cwd: "" });
	}
	const promptOverheadObserved = context.tokens !== null ? options.estimatedTokens / Math.max(1, context.tokens) * 100 : null;
	const toolChars = [...toolMap.values()].reduce((total, tool) => total + tool.resultChars, 0);
	const largestToolResult = Math.max(0, ...[...toolMap.values()].map((tool) => tool.largestResultChars));
	const promptOverhead: ContextFlag = promptOverheadObserved === null
		? { status: "unknown", observed: null, threshold: ">25% of current context token estimate", note: "not comparable while current context estimate is unknown" }
		: { status: promptOverheadObserved > PROMPT_OVERHEAD_PERCENT ? "watch" : "clear", observed: promptOverheadObserved, threshold: ">25% of current context token estimate" };
	const toolBloatObserved = toolChars;
	const toolBloat: ContextFlag = toolChars > TOOL_BLOAT_CHARS || largestToolResult > LARGE_TOOL_RESULT_CHARS
		? { status: "critical", observed: toolBloatObserved, threshold: ">50,000 aggregate chars or any result >20,000 chars", note: `aggregate=${formatNumber(toolChars)} chars; largest=${formatNumber(largestToolResult)} chars` }
		: { status: "clear", observed: toolBloatObserved, threshold: ">50,000 aggregate chars or any result >20,000 chars" };

	return {
		context,
		sessionUsage,
		activeBranchUsage,
		usageSources,
		branch: {
			sessionEntries: sessionEntries.length,
			activeEntries: activeEntries.length,
			sessionMessages: sessionEntries.filter((entry) => recordOf(entry)?.type === "message").length,
			activeMessages: activeEstimate.messages,
			sessionCompactions: sessionEntries.filter((entry) => recordOf(entry)?.type === "compaction").length,
			activeCompactions: activeEntries.filter((entry) => recordOf(entry)?.type === "compaction").length,
			sessionBranchSummaries: sessionEntries.filter((entry) => recordOf(entry)?.type === "branch_summary").length,
			activeBranchSummaries: activeEntries.filter((entry) => recordOf(entry)?.type === "branch_summary").length,
			branchPoints: branchPoints(sessionEntries),
		},
		models: [...models.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
		turns,
		tools: [...toolMap.values()].sort((a, b) => b.resultChars - a.resultChars || a.name.localeCompare(b.name)),
		prompt: options,
		activeEstimate: { ...activeEstimate, estimatedTokens: Math.ceil(activeEstimate.chars / 4) },
		flags: { contextPressure: contextFlag(context), promptOverhead, toolBloat },
	};
}

function formatNumber(value: number | null): string {
	if (value === null) return "unknown";
	return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

function formatBytes(value: number): string {
	if (value < 1_024) return `${value} B`;
	if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
	return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function usageLine(label: string, usage: UsageTotals): string {
	return `${label}: input=${formatNumber(usage.input)} output=${formatNumber(usage.output)} cacheRead=${formatNumber(usage.cacheRead)} cacheWrite=${formatNumber(usage.cacheWrite)} totalTokens=${formatNumber(usage.totalTokens)} cost.total=${formatNumber(usage.costTotal)} (provider-reported/model metadata; not billing accounting)`;
}

function flagLine(label: string, flag: ContextFlag): string {
	const observed = flag.observed === null ? "unknown" : `${formatNumber(flag.observed)}${label === "context pressure" ? "%" : "%"}`;
	return `${label}: ${flag.status}; observed=${observed}; threshold=${flag.threshold}${flag.note ? `; ${flag.note}` : ""}`;
}

function reportLines(report: ContextReport): string[] {
	const lines: string[] = [
		"/context — active-session diagnostics (read-only)",
		"Exact session usage and estimates are labeled; no raw prompts, context files, or tool output are shown.",
		"",
		"Current context (Pi estimate)",
		`tokens=${formatNumber(report.context.tokens)} window=${formatNumber(report.context.contextWindow)} percent=${formatNumber(report.context.percent)}${report.context.percentDerived ? " (computed)" : ""} free=${formatNumber(report.context.freeTokens)}${report.context.unknown ? " — unknown after compaction or before next response" : ""}`,
		"",
		"Session-file spend (all entries and branches, including abandoned branches)",
		usageLine("all session usage", report.sessionUsage),
		`usage sources: assistant=${report.usageSources.assistant} toolResult.usage=${report.usageSources.toolResult} compaction.usage=${report.usageSources.compaction} branch-summary.usage=${report.usageSources.branchSummary}; each entry counted once`,
		"toolResult.usage is counted only when present for nested LLM work; ordinary tool results contribute chars/bytes, not token spend.",
		usageLine("active branch usage (subset)", report.activeBranchUsage),
		"",
		"Active branch context",
		`entries=${report.branch.activeEntries} messages=${report.branch.activeMessages}; session-file entries=${report.branch.sessionEntries} messages=${report.branch.sessionMessages}; branch points=${report.branch.branchPoints}`,
		`compactions active/session=${report.branch.activeCompactions}/${report.branch.sessionCompactions}; branch summaries active/session=${report.branch.activeBranchSummaries}/${report.branch.sessionBranchSummaries}`,
		"",
		"Flags (transparent thresholds only)",
		flagLine("context pressure", report.flags.contextPressure),
		flagLine("prompt overhead", report.flags.promptOverhead),
		flagLine("tool bloat", report.flags.toolBloat),
		"",
		"Provider/model facts",
	];
	for (const model of report.models.slice(0, 16)) lines.push(`${model.provider}/${model.model}: calls=${model.calls}; ${usageLine("usage", model.usage)}`);
	if (report.models.length > 16) lines.push(`… ${report.models.length - 16} more provider/model groups`);
	lines.push("", "Per-turn facts (one provider response per turn; duration/exact token timing unavailable)");
	for (const turn of report.turns.slice(-16)) lines.push(`turn ${turn.turn}: ${turn.provider}/${turn.model}; toolCalls=${turn.toolCalls} toolResults=${turn.toolResults}; totalTokens=${formatNumber(turn.usage.totalTokens)}`);
	if (report.turns.length > 16) lines.push(`… ${report.turns.length - 16} earlier turns omitted`);
	lines.push("", "Tool facts (result sizes are text chars/UTF-8 bytes)");
	for (const tool of report.tools.slice(0, 20)) lines.push(`${tool.name}: calls=${tool.calls} results=${tool.results} chars=${formatNumber(tool.resultChars)} bytes=${formatBytes(tool.resultBytes)} largest=${formatNumber(tool.largestResultChars)} errors=${tool.errors} excluded-from-context=${tool.excludedFromContext} very-large=${tool.largeResults}`);
	if (report.tools.length > 20) lines.push(`… ${report.tools.length - 20} more tools omitted`);
	lines.push(
		"",
		"Prompt contributors (metadata/estimates; raw content intentionally omitted)",
		`custom prompt: ${formatNumber(report.prompt.customPrompt.chars)} chars / ${formatBytes(report.prompt.customPrompt.bytes)}`,
		`selected tools: ${report.prompt.selectedTools.count} (${report.prompt.selectedTools.names.slice(0, 12).join(", ") || "none"}${report.prompt.selectedTools.names.length > 12 ? ", …" : ""})`,
		`tool snippets: ${report.prompt.toolSnippets.count}; ${formatNumber(report.prompt.toolSnippets.chars)} chars / ${formatBytes(report.prompt.toolSnippets.bytes)}`,
		`guidelines: ${report.prompt.guidelines.count}; ${formatNumber(report.prompt.guidelines.chars)} chars / ${formatBytes(report.prompt.guidelines.bytes)}`,
		`append prompt: ${formatNumber(report.prompt.appendPrompt.chars)} chars / ${formatBytes(report.prompt.appendPrompt.bytes)}`,
		`context files: ${report.prompt.contextFiles.count}; paths=${formatNumber(report.prompt.contextFiles.pathChars)} chars; content estimate=${formatNumber(report.prompt.contextFiles.contentChars)} chars / ${formatBytes(report.prompt.contextFiles.contentBytes)}`,
		`skills: ${report.prompt.skills.count} (${report.prompt.skills.names.slice(0, 12).join(", ") || "none"}); metadata estimate=${formatNumber(report.prompt.skills.metadataChars)} chars / ${formatBytes(report.prompt.skills.metadataBytes)}`,
		`prompt contributor total estimate: ${formatNumber(report.prompt.totalChars)} chars / ${formatBytes(report.prompt.totalBytes)}; ~${formatNumber(report.prompt.estimatedTokens)} tokens (chars÷4 estimate)`,
		`active entries/messages estimate: entries=${report.activeEstimate.entries} messages=${report.activeEstimate.messages}; ${formatNumber(report.activeEstimate.chars)} chars / ${formatBytes(report.activeEstimate.bytes)}; ~${formatNumber(report.activeEstimate.estimatedTokens)} tokens (chars÷4 estimate)`,
		"",
		"Press q, Escape, or Ctrl-C to close.",
	);
	return lines;
}

export function formatContextReport(report: ContextReport, maxLines = MAX_REPORT_LINES): string {
	const lines = reportLines(report);
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, Math.max(1, maxLines - 1)), `… report bounded at ${maxLines} lines`].join("\n");
}

export class ContextReportComponent implements Component {
	private readonly scroll: ScrollView;
	constructor(private readonly text: string, private readonly done: () => void, private readonly theme: Theme) {
		const themed = text.split("\n").map((line) => {
			if (line === "/context — active-session diagnostics (read-only)" || /^[A-Z][^:]+$/.test(line)) return theme.fg("accent", line);
			if (/^(context pressure|prompt overhead|tool bloat): (critical|watch)/.test(line)) return theme.fg("warning", line);
			return line;
		}).join("\n");
		this.scroll = new ScrollView(new Text(themed, 1, 1), { scrollbar: "always", overscroll: "contain" });
	}
	render(width: number): string[] { return this.scroll.render(width); }
	invalidate(): void { this.scroll.invalidate(); }
	handleInput(data: string): void {
		if (data === "q" || data === "Q" || data === "\x1b" || data === "\x03") return this.done();
		if (data === "\u001b[A" || data === "k") this.scroll.scrollBy(-1);
		else if (data === "\u001b[B" || data === "j") this.scroll.scrollBy(1);
		else if (data === "\u001b[5~") this.scroll.scrollBy(-10);
		else if (data === "\u001b[6~") this.scroll.scrollBy(10);
		else if (data === "g" || data === "\u001b[H") this.scroll.scrollToStart();
		else if (data === "G" || data === "\u001b[F") this.scroll.scrollToEnd();
	}
}

export function registerContextCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("context", {
		description: "Show read-only active-session diagnostics",
		handler: async (_args, ctx) => {
			const report = collectContextReport(ctx as unknown as ContextReportSource);
			const text = formatContextReport(report);
			if (ctx.mode !== "tui") {
				console.log(text);
				return;
			}
			await ctx.ui.custom((_tui, theme, _keybindings, done) => new ContextReportComponent(text, () => done(undefined), theme), {
				overlay: true,
				overlayOptions: { width: "92%", maxHeight: "86%", minWidth: 50, anchor: "center" },
			});
		},
	});
}

export default function contextExtension(pi: ExtensionAPI): void {
	registerContextCommand(pi);
}

