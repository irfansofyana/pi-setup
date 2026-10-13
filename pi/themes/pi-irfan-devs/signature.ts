import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createWatermarkPresentation } from "./watermark-ui.ts";
import { footerUsage, separateFooterStatus } from "./footer-usage.ts";
import { footerStyle, cavemanLevel } from "./footer-style.ts";
import { footerSessionLine, statusChipsLine } from "./session-status.ts";
import { createFooterProgress, type FooterProgress } from "./footer-progress.ts";


type WatermarkPresentation = ReturnType<typeof createWatermarkPresentation>;

const AUTHOR_CREDIT = "crafted from Irfan's Pi setup";
const IRFAN_DEVS_THEME = "pi-irfan-devs";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

type Rgb = [number, number, number];

const PALETTE: Rgb[] = [
	[79, 111, 216], // cobalt
	[72, 167, 255], // azure
	[86, 214, 231], // cyan
	[123, 134, 242], // indigo
];

const PI_LINES = [
	"   ▄██████████████████▄   ",
	"  ██████████████████████  ",
	"  ▀▀   ███        ███ ▀▀  ",
	"       ███        ███     ",
	"       ███        ███     ",
	"      ▄███        ███▄    ",
	"     ▀▀▀▀          ▀▀▀▀   ",
];

const ORBIT_WIDTH = 30;
const ORBIT_HEIGHT = 9;
const ORBIT_INTERVAL_MS = 140;
type OrbitPoint = readonly [x: number, y: number];

function buildOrbitPath(): OrbitPoint[] {
	const path: OrbitPoint[] = [];
	for (let x = 0; x < ORBIT_WIDTH; x++) path.push([x, 0]);
	for (let y = 1; y < ORBIT_HEIGHT; y++) path.push([ORBIT_WIDTH - 1, y]);
	for (let x = ORBIT_WIDTH - 2; x >= 0; x--) path.push([x, ORBIT_HEIGHT - 1]);
	for (let y = ORBIT_HEIGHT - 2; y > 0; y--) path.push([0, y]);
	return path;
}

const ORBIT_PATH = buildOrbitPath();

const WORKING_JOKES = [
	"Real programmers test in production.",
	"It works on my machine.",
	"There are 10 types of people: binary and confused.",
	"Cache invalidation, naming, off-by-one: the holy trinity.",
	"To understand recursion, first understand recursion.",
	"UDP joke sent. You may not get it.",
	"SQL query walks into a bar: can I join?",
	"99 bugs in the code; patch one, now 127.",
	"Programmer: coffee-to-code converter.",
	"I test rarely; when I do, it is prod.",
	"Debugging: detective story where you did it.",
	"Code works perfectly until someone uses it.",
	"My code has no bugs, only random features.",
	"Talk is cheap. Show me the code.",
	"Ctrl+S is my love language.",
	"Java devs wear glasses because they don't C#.",
	"Password set to incorrect. Hint built in.",
	"QA orders -1 beers, 0 beers, and a lizard.",
	"Lightbulb bug? Hardware team owns that.",
	"Lightbulb has finite TTL; known issue.",
	"Java: now with extra ProblemFactory.",
	"Regex solved it; now we have two bugs.",
	"Final_final_REALLY_final.ts",
	"git push --force: because chaos is fun.",
	"Scrum: meeting that should be an email.",
	"Agile: lost, but flexible.",
	"Frontend sees color; backend sees NULL.",
	"Undefined is not a function; it is a lifestyle.",
	"Python devs don't die; they keep iterating.",
	"HTML joke failed: not well structured.",
	"Semicolon walks into a bar; parse error.",
	"I love F5. Very refreshing.",
	"Stack Overflow is my senior engineer.",
	"Deploying Friday, for science.",
	"Client says: can we just add this?",
	"Coffee in, code out, bugs retained.",
	"Off-by-one errors are easy to make twice.",
	"Distributed systems have two hard problems: 2.",
	"Exactly-once delivery arrived twice.",
	"Naming things took longer than the feature.",
	"I changed one line; build changed religion.",
	"YAML: spaces with trust issues.",
	"Docker works here. Best I can do.",
	"TODO eventually becomes architecture.",
	"Legacy code means revenue.",
	"Lint chose violence today.",
	"Compiler wants receipts.",
	"Rubber duck asked for PTO.",
	"Production heard you whisper demo.",
	"In code we trust; in coffee we debug.",
];

function run(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function detectOwner(ctx: ExtensionContext): string {
	return (
		process.env.PI_SIGNATURE_NAME?.trim() ||
		run("git", ["-C", ctx.cwd, "config", "--get", "user.name"]) ||
		run("git", ["config", "--global", "--get", "user.name"]) ||
		run("id", ["-F"]) ||
		userInfo().username ||
		"you"
	);
}

function mix(a: number, b: number, t: number) {
	return Math.round(a + (b - a) * t);
}

function sampleGradient(position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * PALETTE.length;
	const index = Math.floor(scaled);
	const nextIndex = (index + 1) % PALETTE.length;
	const t = scaled - index;
	const a = PALETTE[index]!;
	const b = PALETTE[nextIndex]!;
	return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function fg([r, g, b]: Rgb, text: string) {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars.map((char, index) => (char === " " ? char : fg(sampleGradient(index / span + phase), char))).join("");
}

function center(line: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return truncateToWidth(`${" ".repeat(pad)}${line}`, width, "");
}

function orbitLogoLines(frame: number, width: number): string[] {
	const canvas = Array.from({ length: ORBIT_HEIGHT }, () => Array<string>(ORBIT_WIDTH).fill(" "));

	for (let row = 0; row < PI_LINES.length; row++) {
		const chars = [...PI_LINES[row]!];
		for (let column = 0; column < chars.length; column++) canvas[row + 1]![column + 2] = chars[column]!;
	}

	const primary = ORBIT_PATH[frame % ORBIT_PATH.length]!;
	const secondary = ORBIT_PATH[(frame + Math.floor(ORBIT_PATH.length / 2)) % ORBIT_PATH.length]!;
	canvas[primary[1]]![primary[0]] = "✦";
	canvas[secondary[1]]![secondary[0]] = "·";

	return canvas.map((row, rowIndex) => center(gradientText(row.join(""), rowIndex * 0.025), width));
}

function devSignatureLines(theme: Theme, width: number, cwd: string): string[] {
	const path = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
	const mark = theme.bold(theme.fg("accent", "π"));
	return [truncateToWidth(`${mark} ${theme.fg("dim", `· ${path}`)}`, width, "")];
}

function signatureLines(owner: string, theme: Theme, width: number, frame = 0, cwd = process.cwd()): string[] {
	const title = `${BOLD}${theme.fg("accent", owner)}${RESET}`;
	const credit = theme.fg("muted", AUTHOR_CREDIT);
	if (theme.name === IRFAN_DEVS_THEME) return devSignatureLines(theme, width, cwd);
	if (width < 34) {
		const mark = theme.bold(theme.fg("accent", "π"));
		return [center(`${mark} ${title}`, width), center(credit, width)];
	}
	return [...orbitLogoLines(frame, width), center(title, width), center(credit, width)];
}

function cachedRenderedLineCount(tui: TUI): number | undefined {
	// Pi TUI stores the last normal render here. Reading it is O(1); rendering
	// from the animation timer would walk every mounted component every 140 ms.
	const renderedLines = (tui as unknown as { previousLines?: unknown }).previousLines;
	return Array.isArray(renderedLines) ? renderedLines.length : undefined;
}

function signatureHeader(owner: string, ctx: ExtensionContext, presentation: WatermarkPresentation) {
	return (tui: TUI, theme: Theme) => {
		let frame = 0;
		let animationVisible = true;
		let timer: ReturnType<typeof setInterval> | undefined;
		let timerInterval: number | undefined;
		let disposed = false;
		const stopAnimation = () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			timerInterval = undefined;
		};
		// Theme is a live proxy. Reconcile cadence on /settings changes.
		function syncAnimation() {
			if (disposed || theme.name === IRFAN_DEVS_THEME || process.env.PI_SIGNATURE_ANIMATION === "0") {
				stopAnimation();
				return;
			}
			const interval = ORBIT_INTERVAL_MS;
			if (timer && timerInterval === interval) return;
			stopAnimation();
			timerInterval = interval;
			timer = setInterval(() => {
				const renderedLineCount = cachedRenderedLineCount(tui);
				// Never poll the full render tree or animate an offscreen header.
				// Missing private cache fails closed on unsupported Pi versions.
				const headerInLiveViewport = renderedLineCount !== undefined && renderedLineCount <= tui.terminal.rows;
				if (!animationVisible || !headerInLiveViewport) return;

				frame += 1;
				tui.requestRender();
			}, interval);
		}
		syncAnimation();

		const component = {
			render(width: number): string[] {
				syncAnimation();
				const devs = theme.name === IRFAN_DEVS_THEME;
				animationVisible = !devs && width >= 34;
				const lines = signatureLines(owner, theme, width, frame, ctx.cwd);
				const rendered = devs ? lines : ["", ...lines, ""];
				presentation.header(component, rendered.length, tui, theme);
				return rendered;
			},
			invalidate() { syncAnimation(); presentation.invalidate(); },
			dispose() {
				disposed = true;
				stopAnimation();
				presentation.dispose();
			},
		};
		presentation.header(component, 0, tui, theme);
		return component;
	};
}

function shuffled<T>(items: readonly T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j]!, result[i]!];
	}
	return result;
}

function funnySpinner(theme: Theme): WorkingIndicatorOptions {
	const orbit = ["·π·", "∙π∙", "•π•", "✦π✦", "•π•", "∙π∙"];
	const colors = ["dim", "muted", "warning", "accent", "warning", "muted"] as const;
	const jokes = [...shuffled(WORKING_JOKES), ...shuffled(WORKING_JOKES), ...shuffled(WORKING_JOKES)];
	return {
		frames: jokes.flatMap((joke) =>
			orbit.flatMap((frame, index) => {
				const marker = theme.fg(colors[index]!, frame);
				return [`${marker} ${theme.fg("muted", joke)}`, `${marker} ${theme.fg("dim", joke)}`];
			}),
		),
		intervalMs: 500,
	};
}

function workingIndicator(theme: Theme): WorkingIndicatorOptions {
	if (theme.name !== IRFAN_DEVS_THEME) return funnySpinner(theme);
	return {
		frames: ["·", "∙", "•", "∙"].map((mark) => theme.fg("accent", mark)),
		intervalMs: 220,
	};
}

function sanitizeStatusText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function alignFooterLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) return left + " ".repeat(width - leftWidth - rightWidth) + right;
	const rightBudget = Math.max(0, width - leftWidth - 2);
	if (rightBudget <= 0) return truncateToWidth(left, width, "...");
	const truncatedRight = truncateToWidth(right, rightBudget, "");
	return left + " ".repeat(Math.max(1, width - leftWidth - visibleWidth(truncatedRight))) + truncatedRight;
}

function footerStatsLine(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider, width: number, thinkingLevel: string): string {
	const usage = footerUsage(ctx.sessionManager.getEntries());
	const ink = footerStyle(theme);
	const leftParts: string[] = [];
	if (usage.input) leftParts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage.output) leftParts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage.cacheRead) leftParts.push(theme.fg("dim", `R${formatTokens(usage.cacheRead)}`));
	if (usage.cacheWrite) leftParts.push(theme.fg("dim", `W${formatTokens(usage.cacheWrite)}`));
	if (usage.cost) leftParts.push(ink.cost(`$${usage.cost.toFixed(3)}`));

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
	if (contextWindow) {
		const percent = contextUsage?.percent;
		const label = percent == null ? `?/${formatTokens(contextWindow)}` : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		leftParts.push(ink.context(label, percent));
	}

	const left = leftParts.length ? leftParts.join(" ") : theme.fg("dim", "fresh session");
	let model = ink.model(ctx.model?.id ?? "no-model");
	if (ctx.model?.reasoning) model += ink.separator(" · ") + ink.model(`thinking ${thinkingLevel}`);
	if (footerData.getAvailableProviderCount() > 1 && ctx.model?.provider) {
		const withProvider = `${theme.fg("dim", `(${ctx.model.provider})`)} ${model}`;
		if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) model = withProvider;
	}
	return alignFooterLine(left, model, width);
}

type StatusChip = { priority: number; text: string };

function compactStatusChip(key: string, text: string, theme: Theme): StatusChip | undefined {
	const plain = sanitizeStatusText(text);
	if (!plain) return undefined;
	const ink = footerStyle(theme);

	const goal = plain.match(/^goal\s+([◐◓◑◒])(?:\s+loops)?\s+(\d+\/\d+)/i);
	if (goal) return { priority: 10, text: `${theme.fg("accent", "goal")} ${theme.fg("muted", goal[1]!)} ${theme.fg("dim", goal[2]!)}` };

	if (/^(headroom|hr)\s+off$/i.test(plain)) return { priority: 20, text: theme.fg("dim", "hr off") };
	const headroom = plain.match(/^headroom\s+(?:managed|external|proxy\?)\s+·\s+saved\s+([^ ]+)\s+tok\s+·\s+([\d.]+)%\s+↓$/i) ?? plain.match(/^hr\s+(?:[mx?]\s+)?([^ ]+)\s+↓([\d.]+)%$/i);
	if (headroom) return { priority: 20, text: `${ink.label("hr")} ${theme.fg("dim", headroom[1]!)} ${ink.healthy(`↓${headroom[2]}%`)}` };

	if (/^(hindsight|mem)\s+off$/i.test(plain)) return { priority: 30, text: theme.fg("dim", "mem off") };
	const hindsight = plain.match(/^hindsight\s+on\s+·\s+([^·]+)\s+·\s+(working|checking|offline)$/i) ?? plain.match(/^mem(?::([^ ]+))?\s+(ok|checking|offline)$/i);
	if (hindsight) {
		const state = hindsight[2]!.toLowerCase() === "working" ? "ok" : hindsight[2]!.toLowerCase();
		const value = state === "offline" ? theme.fg("error", state) : state === "checking" ? theme.fg("warning", state) : ink.healthy(state);
		return { priority: state === "offline" ? 0 : theme.name === IRFAN_DEVS_THEME && state === "checking" ? 15 : 30, text: `${ink.label("mem")} ${value}` };
	}

	const mcp = plain.match(/^MCP:?\s+(\d+)\/(\d+)\s+servers?/i);
	if (mcp) {
		const ready = Number(mcp[1]);
		const total = Number(mcp[2]);
		const count = `${ready}/${total}`;
		const value = ready === total && total > 0 ? ink.healthy(count) : theme.fg(ready === 0 ? "warning" : "accent", count);
		return { priority: theme.name === IRFAN_DEVS_THEME && ready < total ? 0 : 40, text: `${ink.label("MCP")} ${value}` };
	}

	const caveman = theme.name === IRFAN_DEVS_THEME ? cavemanLevel(plain) : plain.match(/^caveman(?:\s+level:)?\s+(.+)$/i)?.[1]?.trim();
	if (caveman) return { priority: 50, text: `${ink.label("caveman")} ${ink.mode(caveman)}` };

	const yolo = plain.match(/^yolo\s+(\d+)\s+running\s+agents?/i);
	if (yolo) return { priority: 60, text: `${ink.label("yolo")} ${ink.active(`${yolo[1]} agent`)}` };

	const hasProblem = /\b(error|failed|offline|blocked)\b/i.test(plain);
	const label = truncateToWidth(`${key}: ${plain}`, 34, "…");
	const active = /\b(checking|pending|running|working)\b/i.test(plain);
	return { priority: hasProblem ? 0 : theme.name === IRFAN_DEVS_THEME && active ? 15 : 100, text: hasProblem ? theme.fg("error", label) : active ? ink.active(label) : theme.fg("dim", label) };
}

function footerStatusLine(footerData: ReadonlyFooterDataProvider, theme: Theme, width: number): string | undefined {
	const chips = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => separateFooterStatus(key))
		.map(([key, text]) => compactStatusChip(key, text, theme))
		.filter((chip): chip is StatusChip => Boolean(chip))
		.sort((a, b) => a.priority - b.priority)
		.map((chip) => chip.text);
	if (!chips.length) return undefined;
	if (theme.name === IRFAN_DEVS_THEME) return statusChipsLine(chips, theme, width);
	const ink = footerStyle(theme);
	return truncateToWidth(ink.separator("• ") + chips.join(ink.separator(" · ")), width, theme.fg("dim", "…"));
}

function compactFooter(
	ctx: ExtensionContext,
	presentation: WatermarkPresentation,
	getThinkingLevel: () => string,
	captureFooter: (data: ReadonlyFooterDataProvider | undefined) => void,
	progress: FooterProgress,
) {
	return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
		captureFooter(footerData);
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const releaseProgress = progress.mountFooter(() => theme.name === IRFAN_DEVS_THEME);
		tui.requestRender();
		let disposed = false;
		const component = {
			dispose() {
				if (disposed) return;
				disposed = true;
				unsubscribe();
				releaseProgress();
				tui.requestRender();
				captureFooter(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (disposed) return [];
				const cwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				const devs = theme.name === IRFAN_DEVS_THEME;
				const pathLine = truncateToWidth(
					theme.fg("dim", devs ? basename(ctx.cwd) || cwd : cwd) + (branch ? theme.fg("muted", ` (${branch})`) : ""),
					width, theme.fg("dim", "…"),
				);
				const lines = devs
					? [footerSessionLine(theme, {
						model: ctx.model?.id ?? "no-model",
						thinking: ctx.model?.reasoning ? getThinkingLevel() : undefined,
						contextPercent: ctx.getContextUsage()?.percent,
						cost: footerUsage(ctx.sessionManager.getEntries()).cost,
					}, pathLine, progress.read(width), width)]
					: [pathLine, footerStatsLine(ctx, theme, footerData, width, getThinkingLevel())];
				const statuses = footerStatusLine(footerData, theme, width);
				if (devs) lines.push(statuses ?? "");
				else if (statuses) lines.push(statuses);
				const rendered = devs ? lines.map((line) => {
					const clipped = truncateToWidth(line, width, "");
					return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
				}) : lines;
				presentation.footer(component, rendered.length);
				return rendered;
			},
		};
		presentation.footer(component, theme.name === IRFAN_DEVS_THEME ? 2 : 3);
		return component;
	};
}

export default function piSignature(pi: ExtensionAPI, progress: FooterProgress = createFooterProgress()) {
	let presentation: WatermarkPresentation | undefined;
	let currentFooter: ReadonlyFooterDataProvider | undefined;
	const activeTools = new Map<string, string>();
	const updateWorkingMessage = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || ctx.ui.theme.name !== IRFAN_DEVS_THEME) return;
		const names = [...new Set(activeTools.values())].slice(0, 2).join(", ");
		ctx.ui.setWorkingMessage(activeTools.size
			? `${activeTools.size} tool${activeTools.size === 1 ? "" : "s"} · ${names}`
			: "Working");
	};
	pi.on("session_start", async (event, ctx) => {
		progress.reset();
		presentation?.dispose();
		presentation = undefined;
		currentFooter = undefined;
		activeTools.clear();
		if (ctx.mode !== "tui") return;
		presentation = createWatermarkPresentation(ctx, event.reason);
		const owner = detectOwner(ctx);
		ctx.ui.setHeader(signatureHeader(owner, ctx, presentation));
		ctx.ui.setWorkingMessage(ctx.ui.theme.name === IRFAN_DEVS_THEME ? "Working" : "");
		ctx.ui.setWorkingIndicator(workingIndicator(ctx.ui.theme));
		presentation.install();
		if (process.env.PI_SIGNATURE_COMPACT_FOOTER !== "0") {
			ctx.ui.setFooter(compactFooter(ctx, presentation, () => pi.getThinkingLevel(), data => { currentFooter = data; }, progress));
		}
		ctx.ui.setTitle(`π · ${owner} · Irfan's Pi setup`);
	});
	pi.on("agent_start", async (_event, ctx) => {
		presentation?.retire();
		if (ctx.mode !== "tui") return;
		activeTools.clear();
		ctx.ui.setWorkingMessage(ctx.ui.theme.name === IRFAN_DEVS_THEME ? "Working" : "");
		ctx.ui.setWorkingIndicator(workingIndicator(ctx.ui.theme));
	});
	pi.on("tool_execution_start", (event, ctx) => {
		activeTools.set(event.toolCallId, sanitizeStatusText(event.toolName));
		updateWorkingMessage(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		activeTools.delete(event.toolCallId);
		updateWorkingMessage(ctx);
	});
	pi.on("agent_end", (_event, ctx) => { activeTools.clear(); updateWorkingMessage(ctx); });
	pi.on("agent_settled", () => { activeTools.clear(); });
	pi.on("input", () => { presentation?.retire(); return undefined; });
	pi.on("message_start", () => { presentation?.retire(); });
	pi.on("user_bash", () => { presentation?.retire(); return undefined; });
	pi.on("session_tree", () => { presentation?.retire(); });
	pi.on("session_shutdown", () => {
		progress.reset();
		presentation?.dispose();
		presentation = undefined;
		currentFooter = undefined;
		activeTools.clear();
	});
	pi.registerCommand("pi-ui", {
		description: "Inspect model, main-session usage, total settled cost and all service statuses (read-only)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const usage = footerUsage(ctx.sessionManager.getEntries());
			const context = ctx.getContextUsage();
			const percent = context?.percent;
			const window = context?.contextWindow ?? ctx.model?.contextWindow;
			const lines = [
				`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model"}${ctx.model?.reasoning ? ` · thinking ${pi.getThinkingLevel()}` : ""}`,
				`Context (main session estimate): ${percent == null ? "unknown" : `${percent.toFixed(1)}%`}${window ? ` / ${formatTokens(window)}` : ""}`,
				`Main tokens: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}`,
				`Recorded cost: $${usage.cost.toFixed(3)} (main + settled children; not live child billing)`,
			];
			for (const [key, text] of currentFooter?.getExtensionStatuses() ?? []) {
				if (separateFooterStatus(key)) lines.push(`${sanitizeStatusText(key)}: ${sanitizeStatusText(text)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	pi.registerCommand("pi-watermark", {
		description: "Replay Pi welcome artwork, or inspect visibility with status",
		handler: async (args, ctx) => {
			if (args.trim() === "status") {
				ctx.ui.notify(presentation?.status() ?? "Welcome panel inactive: terminal UI required.", "info");
				return;
			}
			if (args.trim() && args.trim() !== "replay") {
				ctx.ui.notify("Usage: /pi-watermark [replay|status]", "info");
				return;
			}
			if (!presentation?.replay()) ctx.ui.notify(presentation?.status() ?? "Welcome panel inactive: terminal UI required.", "info");
		},
	});
	return (editor: Component & { focused?: boolean; isShowingAutocomplete?(): boolean }, rows: number) => {
		presentation?.editor(editor, rows);
	};
}
