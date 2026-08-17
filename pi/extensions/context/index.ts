import type { BuildSystemPromptOptions, ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
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

export interface SkillUsage {
	name: string;
	invocations: number;
}

export interface SizeInfo {
	chars: number;
	bytes: number;
}

export interface PromptMetadata {
	customPrompt: SizeInfo;
	selectedTools: { count: number; names: string[] };
	toolSnippets: { count: number; chars: number; bytes: number };
	guidelines: { count: number; chars: number; bytes: number };
	appendPrompt: SizeInfo;
	contextFiles: { count: number; pathChars: number; contentChars: number; contentBytes: number };
	skills: { count: number; names: string[]; metadataChars: number; metadataBytes: number };
	totalChars: number;
	totalBytes: number;
	unavailable: boolean;
}

export interface LastPrompt {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	totalTokens: number;
	contextWindow: number | null;
	percent: number | null;
	note?: string;
	unknown: boolean;
}

export interface ToolBloat {
	status: "clear" | "critical";
	observedChars: number;
	largestChars: number;
	threshold: string;
}

export interface ContextReport {
	model: { provider: string; id: string; contextWindow: number | null };
	lastPrompt: LastPrompt;
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
	skills: SkillUsage[];
	systemPrompt: { chars: number; bytes: number; available: boolean };
	prompt: PromptMetadata;
	toolBloat: ToolBloat;
}

export interface ContextReportSource {
	model?: { contextWindow?: number; provider?: string; id?: string };
	sessionManager: {
		getEntries: () => unknown[];
		buildContextEntries: () => unknown[];
	};
	getSystemPromptOptions: () => BuildSystemPromptOptions;
	getSystemPrompt: () => string;
}

const ZERO_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
const LARGE_TOOL_RESULT_CHARS = 20_000;
const TOOL_BLOAT_CHARS = 50_000;
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

function blockText(part: unknown): string {
	if (typeof part === "string") return part;
	if (!part || typeof part !== "object") return "";
	const record = part as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (record.type === "thinking" && typeof record.thinking === "string") return `[thinking] ${record.thinking}`;
	if (record.type === "toolCall") {
		const name = typeof record.name === "string" ? record.name : "unknown-tool";
		const args = record.arguments === undefined ? "" : ` ${JSON.stringify(record.arguments)}`;
		return `[toolCall ${name}]${args}`;
	}
	if (record.type === "image") return `[image ${typeof record.mimeType === "string" ? record.mimeType : "unknown"}]`;
	return "";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(blockText).join("\n");
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
	if (typeof value === "string") return { chars: value.length, bytes: byteLength(value) };
	if (!Array.isArray(value)) return { chars: 0, bytes: 0 };
	let chars = 0;
	let bytes = 0;
	for (const part of value) {
		const record = recordOf(part);
		if (record?.type === "image") {
			// Measure the stored payload, not the placeholder marker, so large
			// image results are reflected in sizes and the bloat threshold.
			const data = typeof record.data === "string" ? record.data : "";
			chars += data.length;
			bytes += byteLength(data);
			continue;
		}
		const text = blockText(part);
		chars += text.length;
		bytes += byteLength(text);
	}
	return { chars, bytes };
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

function promptMetadata(options: BuildSystemPromptOptions): PromptMetadata {
	const customPrompt = contentSize(options.customPrompt);
	const selectedTools = options.selectedTools ?? [];
	const snippets = Object.entries(options.toolSnippets ?? {})
		.filter(([name]) => selectedTools.includes(name))
		.map(([, value]) => value);
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
		selectedTools: { count: selectedTools.length, names: [...selectedTools] },
		toolSnippets: { count: snippets.length, ...toolSnippets },
		guidelines: { count: (options.promptGuidelines ?? []).length, ...guidelines },
		appendPrompt,
		contextFiles,
		skills,
		totalChars,
		totalBytes,
		unavailable: false,
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

function modelKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

function skillInvocations(entries: unknown[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const record = recordOf(entry);
		if (record?.type !== "message") continue;
		const message = recordOf(record.message);
		if (!message || message.role !== "user") continue;
		const match = textFromContent(message.content).match(/^\s*<skill name="([^"]+)"/);
		if (match?.[1]) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	}
	return counts;
}

function lastAssistantWithUsage(entries: unknown[]): { provider: string; model: string; usage: UsageTotals } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const record = recordOf(entries[i]);
		if (record?.type !== "message") continue;
		const message = recordOf(record.message);
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		if (!usageIsPresent(message.usage)) continue;
		const usage = usageValue(message.usage);
		if (usage.input <= 0 && usage.output <= 0 && usage.totalTokens <= 0) continue;
		return {
			provider: typeof message.provider === "string" ? message.provider : "unknown",
			model: typeof message.model === "string" ? message.model : "unknown",
			usage,
		};
	}
	return undefined;
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
			} else if (message.role === "user") {
				currentTurn = undefined;
			} else if (message.role === "toolResult" || message.role === "bashExecution") {
				if (usageIsPresent(message.usage)) {
					if (targetUsage) addUsage(targetUsage, message.usage);
					if (collectFacts) usageSources.toolResult++;
				}
				if (!collectFacts) continue;
				const name = message.role === "bashExecution" ? "bash" : typeof message.toolName === "string" ? message.toolName : "unknown-tool";
				const tool = toolMap.get(name) ?? { name, calls: 0, results: 0, resultChars: 0, resultBytes: 0, errors: 0, excludedFromContext: 0, largeResults: 0, largestResultChars: 0 };
				const size = message.role === "bashExecution"
					? contentSize(`${String(message.command ?? "")}\n${String(message.output ?? "")}`)
					: contentSize(message.content);
				tool.results++;
				tool.resultChars += size.chars;
				tool.resultBytes += size.bytes;
				if (message.isError === true || message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0)) tool.errors++;
				if (excludedFromContext(message)) tool.excludedFromContext++;
				if (size.chars > LARGE_TOOL_RESULT_CHARS) tool.largeResults++;
				tool.largestResultChars = Math.max(tool.largestResultChars, size.chars);
				if (message.role === "toolResult" && currentTurn) currentTurn.toolResults++;
				toolMap.set(name, tool);
			}
		}
	};

	processEntries(sessionEntries, sessionUsage, true);
	processEntries(activeEntries, activeBranchUsage, false);

	const last = lastAssistantWithUsage(activeEntries);
	const contextWindow = numberValue(ctx.model?.contextWindow) || null;
	const modelMatches = Boolean(
		last && (!ctx.model?.provider || ctx.model.provider === last.provider) && (!ctx.model?.id || ctx.model.id === last.model),
	);
	const promptTokens = last ? last.usage.input + last.usage.cacheRead + last.usage.cacheWrite : 0;
	const lastPrompt: LastPrompt = last
		? {
			input: last.usage.input,
			output: last.usage.output,
			cacheRead: last.usage.cacheRead,
			cacheWrite: last.usage.cacheWrite,
			promptTokens,
			totalTokens: last.usage.totalTokens,
			contextWindow,
			percent: contextWindow && modelMatches ? (promptTokens / contextWindow) * 100 : null,
			note: modelMatches ? undefined : `previous turn ran ${last.provider}/${last.model} (differs from current model)`,
			unknown: false,
		}
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0, totalTokens: 0, contextWindow, percent: null, note: undefined, unknown: true };

	const model = {
		provider: typeof ctx.model?.provider === "string" && ctx.model.provider ? ctx.model.provider : (last?.provider ?? "unknown"),
		id: typeof ctx.model?.id === "string" && ctx.model.id ? ctx.model.id : (last?.model ?? "unknown"),
		contextWindow,
	};

	let systemPrompt = { chars: 0, bytes: 0, available: false };
	try {
		const text = ctx.getSystemPrompt();
		if (typeof text === "string") systemPrompt = { chars: text.length, bytes: byteLength(text), available: true };
	} catch {
		// getSystemPrompt unavailable in this context.
	}

	let options: PromptMetadata;
	let promptUnavailable = false;
	try {
		options = promptMetadata(ctx.getSystemPromptOptions());
	} catch {
		options = promptMetadata({ cwd: "" });
		promptUnavailable = true;
	}
	options = { ...options, unavailable: promptUnavailable };

	const toolChars = [...toolMap.values()].reduce((total, tool) => total + tool.resultChars, 0);
	const largestToolResult = Math.max(0, ...[...toolMap.values()].map((tool) => tool.largestResultChars));
	const toolBloat: ToolBloat = toolChars > TOOL_BLOAT_CHARS || largestToolResult > LARGE_TOOL_RESULT_CHARS
		? { status: "critical", observedChars: toolChars, largestChars: largestToolResult, threshold: ">50,000 aggregate chars or any result >20,000 chars" }
		: { status: "clear", observedChars: toolChars, largestChars: largestToolResult, threshold: ">50,000 aggregate chars or any result >20,000 chars" };

	const activeMessageCount = activeEntries.filter((entry) => {
		const record = recordOf(entry);
		return record?.type === "message" || record?.type === "custom_message";
	}).length;

	return {
		model,
		lastPrompt,
		sessionUsage,
		activeBranchUsage,
		usageSources,
		branch: {
			sessionEntries: sessionEntries.length,
			activeEntries: activeEntries.length,
			sessionMessages: sessionEntries.filter((entry) => recordOf(entry)?.type === "message").length,
			activeMessages: activeMessageCount,
			sessionCompactions: sessionEntries.filter((entry) => recordOf(entry)?.type === "compaction").length,
			activeCompactions: activeEntries.filter((entry) => recordOf(entry)?.type === "compaction").length,
			sessionBranchSummaries: sessionEntries.filter((entry) => recordOf(entry)?.type === "branch_summary").length,
			activeBranchSummaries: activeEntries.filter((entry) => recordOf(entry)?.type === "branch_summary").length,
			branchPoints: branchPoints(sessionEntries),
		},
		models: [...models.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
		turns,
		tools: [...toolMap.values()].sort((a, b) => b.resultChars - a.resultChars || a.name.localeCompare(b.name)),
		skills: [...skillInvocations(sessionEntries).entries()]
			.map(([name, invocations]) => ({ name, invocations }))
			.sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name)),
		systemPrompt,
		prompt: options,
		toolBloat,
	};
}

function formatNumber(value: number | null): string {
	if (value === null) return "unknown";
	return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

function formatCost(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatBytes(value: number): string {
	if (value < 1_024) return `${value} B`;
	if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
	return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function usageLine(label: string, usage: UsageTotals): string {
	return `${label}: input=${formatNumber(usage.input)} output=${formatNumber(usage.output)} cacheRead=${formatNumber(usage.cacheRead)} cacheWrite=${formatNumber(usage.cacheWrite)} totalTokens=${formatNumber(usage.totalTokens)} cost.total=${formatCost(usage.costTotal)} (tokens provider-reported; cost model-derived, not billing accounting)`;
}

type Paint = (color: ThemeColor, text: string) => string;

const noPaint: Paint = (_color, text) => text;

function singleBar(ratio: number, width: number, paint: Paint, fill: ThemeColor = "accent"): string {
	const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
	const filled = Math.round(clamped * width);
	return paint(fill, "▓".repeat(filled)) + paint("dim", "░".repeat(Math.max(0, width - filled)));
}

function barFillColor(ratio: number): ThemeColor {
	if (!Number.isFinite(ratio)) return "dim";
	if (ratio >= CONTEXT_CRITICAL_PERCENT / 100) return "error";
	if (ratio >= CONTEXT_WATCH_PERCENT / 100) return "warning";
	return "accent";
}

function dashboardLines(report: ContextReport, paint: Paint = noPaint): string[] {
	const lines: string[] = [];
	lines.push("/context — session facts");

	lines.push(`model  ${report.model.provider}/${report.model.id} · window ${formatNumber(report.model.contextWindow)}`);

	lines.push("");
	lines.push(paint("muted", "last prompt (previous turn, provider-reported)"));
	const ratio = report.lastPrompt.percent !== null ? report.lastPrompt.percent / 100 : 0;
	lines.push(singleBar(ratio, 40, paint, barFillColor(ratio)));
	if (report.lastPrompt.unknown) {
		lines.push("no completed turn yet");
	} else if (report.lastPrompt.percent !== null) {
		lines.push(`${formatNumber(report.lastPrompt.promptTokens)} / ${formatNumber(report.lastPrompt.contextWindow)} prompt tokens · ${formatNumber(report.lastPrompt.percent)}%`);
	} else if (report.lastPrompt.note) {
		lines.push(`${formatNumber(report.lastPrompt.promptTokens)} prompt tokens · ${report.lastPrompt.note}`);
	} else {
		lines.push(`${formatNumber(report.lastPrompt.promptTokens)} prompt tokens · window unknown`);
	}
	lines.push("");

	lines.push(`spend  in ${formatNumber(report.sessionUsage.input)} · out ${formatNumber(report.sessionUsage.output)} · cache ${formatNumber(report.sessionUsage.cacheRead)}/${formatNumber(report.sessionUsage.cacheWrite)} · total ${formatNumber(report.sessionUsage.totalTokens)} · $${formatCost(report.sessionUsage.costTotal)}`);
	lines.push(`turns ${report.turns.length}${report.models.length ? ` · ${report.models.slice(0, 4).map((model) => `${model.provider}/${model.model} ×${model.calls}`).join(" · ")}${report.models.length > 4 ? " · …" : ""}` : ""}`);

	if (report.tools.length) {
		lines.push("");
		lines.push(paint("muted", "tools (result sizes are exact chars/bytes)"));
		for (const tool of report.tools.slice(0, 4)) {
			const large = tool.largestResultChars > LARGE_TOOL_RESULT_CHARS ? paint("error", "  ⚠ >20k") : "";
			lines.push(`  ${tool.name} ×${tool.calls} · ${formatNumber(tool.resultChars)} chars · ${formatBytes(tool.resultBytes)}${large}`);
		}
		if (report.tools.length > 4) lines.push(paint("dim", `  … ${report.tools.length - 4} more tools`));
	}

	lines.push("");
	lines.push(report.skills.length
		? `skills  ${report.skills.slice(0, 8).map((skill) => `${skill.name} ×${skill.invocations}`).join(" · ")}${report.skills.length > 8 ? " · …" : ""}`
		: "skills  none (explicit invocations only)");
	lines.push(`session  ${report.branch.sessionMessages} messages · ${report.branch.sessionCompactions} compactions · ${report.branch.branchPoints} branch points · ${report.branch.sessionBranchSummaries} summaries`);
	lines.push(report.systemPrompt.available
		? `prompt  ${formatNumber(report.systemPrompt.chars)} chars · ${formatBytes(report.systemPrompt.bytes)} (measured, not tokenized)`
		: "prompt  unavailable");

	if (report.toolBloat.status === "critical") {
		lines.push("");
		lines.push(paint("error", `tool bloat  aggregate ${formatNumber(report.toolBloat.observedChars)} chars (limit ${formatNumber(TOOL_BLOAT_CHARS)}) · largest ${formatNumber(report.toolBloat.largestChars)} chars (limit ${formatNumber(LARGE_TOOL_RESULT_CHARS)})`));
	}

	return lines;
}

function detailLines(report: ContextReport, paint: Paint = noPaint): string[] {
	const header = (text: string) => paint("accent", text);
	const lines: string[] = [
		"",
		header("Model & window"),
		`${report.model.provider}/${report.model.id} · window=${formatNumber(report.model.contextWindow)} (configured value, not usage)`,
		"",
		header("Last prompt (exact, provider-reported — previous completed turn)"),
	];
	if (report.lastPrompt.unknown) {
		lines.push("no completed assistant turn with reported usage yet");
	} else {
		lines.push(`input=${formatNumber(report.lastPrompt.input)} output=${formatNumber(report.lastPrompt.output)} cacheRead=${formatNumber(report.lastPrompt.cacheRead)} cacheWrite=${formatNumber(report.lastPrompt.cacheWrite)} totalTokens=${formatNumber(report.lastPrompt.totalTokens)}`);
		lines.push(`prompt (input+cacheRead+cacheWrite)=${formatNumber(report.lastPrompt.promptTokens)}`);
		if (report.lastPrompt.percent !== null) {
			lines.push(`prompt vs window: ${formatNumber(report.lastPrompt.promptTokens)} / ${formatNumber(report.lastPrompt.contextWindow)} = ${formatNumber(report.lastPrompt.percent)}%`);
		} else if (report.lastPrompt.note) {
			lines.push(`percent omitted: ${report.lastPrompt.note}`);
		} else {
			lines.push("percent omitted: context window unknown");
		}
	}
	lines.push("", header("Spend (exact provider-reported usage, all session entries)"), usageLine("all", report.sessionUsage));
	lines.push(`usage sources: assistant=${report.usageSources.assistant} toolResult.usage=${report.usageSources.toolResult} compaction.usage=${report.usageSources.compaction} branch-summary.usage=${report.usageSources.branchSummary}; each entry counted once`);
	lines.push("toolResult.usage is counted only when present for nested LLM work; ordinary tool results contribute chars/bytes, not token spend.");
	lines.push(usageLine("active branch (subset)", report.activeBranchUsage));
	lines.push("", header("Provider/model facts"));
	for (const model of report.models.slice(0, 16)) lines.push(`${model.provider}/${model.model}: calls=${model.calls}; ${usageLine("usage", model.usage)}`);
	if (report.models.length > 16) lines.push(`… ${report.models.length - 16} more provider/model groups`);
	lines.push("", header("Per-turn facts (exact; one provider response per turn)"));
	for (const turn of report.turns.slice(-16)) lines.push(`turn ${turn.turn}: ${turn.provider}/${turn.model}; toolCalls=${turn.toolCalls} toolResults=${turn.toolResults}; ${usageLine("usage", turn.usage)}`);
	if (report.turns.length > 16) lines.push(`… ${report.turns.length - 16} earlier turns omitted`);
	lines.push("", header("Tool facts (result sizes are exact chars/bytes)"));
	for (const tool of report.tools.slice(0, 20)) lines.push(`${tool.name}: calls=${tool.calls} results=${tool.results} chars=${formatNumber(tool.resultChars)} bytes=${formatBytes(tool.resultBytes)} largest=${formatNumber(tool.largestResultChars)} errors=${tool.errors} excluded-from-context=${tool.excludedFromContext} very-large=${tool.largeResults}`);
	if (report.tools.length > 20) lines.push(`… ${report.tools.length - 20} more tools omitted`);
	if (report.prompt.unavailable) {
		lines.push("", header("Prompt contributors: unavailable (system-prompt options not exposed in this context)"));
	} else {
		lines.push("", header("Prompt contributors (exact chars/bytes; no token estimate)"));
		lines.push(
			`custom prompt: ${formatNumber(report.prompt.customPrompt.chars)} chars / ${formatBytes(report.prompt.customPrompt.bytes)}`,
			`selected tools: ${report.prompt.selectedTools.count} (${report.prompt.selectedTools.names.slice(0, 12).join(", ") || "none"}${report.prompt.selectedTools.names.length > 12 ? ", …" : ""})`,
			`tool snippets: ${report.prompt.toolSnippets.count}; ${formatNumber(report.prompt.toolSnippets.chars)} chars / ${formatBytes(report.prompt.toolSnippets.bytes)}`,
			`guidelines: ${report.prompt.guidelines.count}; ${formatNumber(report.prompt.guidelines.chars)} chars / ${formatBytes(report.prompt.guidelines.bytes)}`,
			`append prompt: ${formatNumber(report.prompt.appendPrompt.chars)} chars / ${formatBytes(report.prompt.appendPrompt.bytes)}`,
			`context files: ${report.prompt.contextFiles.count}; paths=${formatNumber(report.prompt.contextFiles.pathChars)} chars; content=${formatNumber(report.prompt.contextFiles.contentChars)} chars / ${formatBytes(report.prompt.contextFiles.contentBytes)}`,
			`skills: ${report.prompt.skills.count} (${report.prompt.skills.names.slice(0, 12).join(", ") || "none"}); metadata=${formatNumber(report.prompt.skills.metadataChars)} chars / ${formatBytes(report.prompt.skills.metadataBytes)}`,
			`total contributor text: ${formatNumber(report.prompt.totalChars)} chars / ${formatBytes(report.prompt.totalBytes)} (measured, not tokenized)`,
		);
	}
	lines.push("", header("Assembled system prompt (measured, not tokenized)"));
	lines.push(report.systemPrompt.available ? `chars=${formatNumber(report.systemPrompt.chars)} bytes=${formatBytes(report.systemPrompt.bytes)}` : "unavailable in this context");
	lines.push("", header("Active branch"));
	lines.push(`entries=${report.branch.activeEntries} messages=${report.branch.activeMessages}; session-file entries=${report.branch.sessionEntries} messages=${report.branch.sessionMessages}; branch points=${report.branch.branchPoints}`);
	lines.push(`compactions active/session=${report.branch.activeCompactions}/${report.branch.sessionCompactions}; branch summaries active/session=${report.branch.activeBranchSummaries}/${report.branch.sessionBranchSummaries}`);
	return lines;
}

export function formatDashboard(report: ContextReport): string {
	return dashboardLines(report).join("\n");
}

export function formatContextReport(report: ContextReport, maxLines = MAX_REPORT_LINES): string {
	const lines = [...dashboardLines(report), ...detailLines(report)];
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, Math.max(1, maxLines - 1)), `… report bounded at ${maxLines} lines`].join("\n");
}

type ContextTui = {
	height?: number;
	requestRender?: () => void;
};

export class ContextReportComponent {
	private readonly dashboard: string[];
	private readonly details: string[];
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly viewport: number;
	private showDetails = false;
	private offset = 0;
	private wrapped: string[] = [];

	constructor(report: ContextReport, done: () => void, theme: Theme, tui?: ContextTui) {
		this.done = done;
		this.requestRender = tui?.requestRender?.bind(tui) ?? (() => {});
		this.viewport = Math.max(8, Math.floor((tui?.height ?? 32) * 0.86));
		const paint: Paint = (color, text) => theme.fg(color, text);
		this.dashboard = [...dashboardLines(report, paint), "", paint("dim", "[j/k] scroll · [d] details · [q] close")];
		this.details = [...detailLines(report, paint), "", paint("dim", "[j/k] scroll · [d] dashboard · [q] close")];
	}

	private currentLines(): string[] {
		return this.showDetails ? this.details : this.dashboard;
	}

	render(width: number): string[] {
		const usable = Math.max(1, width);
		this.wrapped = this.currentLines().flatMap((line) => wrapTextWithAnsi(line, usable));
		this.offset = Math.min(this.offset, this.maxOffset());
		return this.wrapped.slice(this.offset, this.offset + this.viewport);
	}

	private maxOffset(): number {
		return Math.max(0, this.wrapped.length - this.viewport);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "q" || data === "Q" || data === "\x1b" || data === "\x03") return this.done();
		if (data === "d" || data === "D") {
			this.showDetails = !this.showDetails;
			this.offset = 0;
			this.requestRender();
			return;
		}
		const previous = this.offset;
		const max = this.maxOffset();
		if (data === "\u001b[A" || data === "k") this.offset = Math.max(0, this.offset - 1);
		else if (data === "\u001b[B" || data === "j") this.offset = Math.min(max, this.offset + 1);
		else if (data === "\u001b[5~") this.offset = Math.max(0, this.offset - 10);
		else if (data === "\u001b[6~") this.offset = Math.min(max, this.offset + 10);
		else if (data === "g" || data === "\u001b[H") this.offset = 0;
		else if (data === "G" || data === "\u001b[F") this.offset = max;
		if (this.offset !== previous) this.requestRender();
	}
}

export function registerContextCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("context", {
		description: "Show exact read-only session facts (reported, no estimates)",
		handler: async (_args, ctx) => {
			const report = collectContextReport(ctx as unknown as ContextReportSource);
			if (ctx.mode === "print") {
				console.log(formatContextReport(report));
				return;
			}
			if (ctx.mode === "rpc") {
				ctx.ui.notify(formatDashboard(report), "info");
				return;
			}
			if (ctx.mode === "json") {
				console.error(formatDashboard(report));
				return;
			}
			await ctx.ui.custom((tui, theme, _keybindings, done) => new ContextReportComponent(report, () => done(undefined), theme, tui), {
				overlay: true,
				overlayOptions: { width: "92%", maxHeight: "86%", minWidth: 50, anchor: "center" },
			});
		},
	});
}

export default function contextExtension(pi: ExtensionAPI): void {
	registerContextCommand(pi);
}
