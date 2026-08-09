import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const AUTHOR_CREDIT = "crafted from Irfan's Pi setup";
const MINIMAL_THEME = "irfan-sumi";
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

function signatureLines(owner: string, theme: Theme, width: number, frame = 0): string[] {
	const title = `${BOLD}${theme.fg("accent", owner)}${RESET}`;
	const credit = theme.fg("muted", AUTHOR_CREDIT);

	if (theme.name === MINIMAL_THEME) {
		const mark = theme.bold(theme.fg("accent", "π"));
		return [truncateToWidth(` ${mark}  ${title} ${theme.fg("dim", "·")} ${credit}`, width, "")];
	}

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

function signatureHeader(owner: string) {
	return (tui: TUI, theme: Theme) => {
		let frame = 0;
		let animationVisible = true;
		const timer = setInterval(() => {
			const renderedLineCount = cachedRenderedLineCount(tui);
			// Updating an offscreen header makes Pi fully redraw and clear terminal scrollback.
			// Fail closed if Pi TUI stops exposing cached render lines; disabling animation is
			// safer than bringing back full offscreen redraws on an unsupported version.
			const headerInLiveViewport = renderedLineCount !== undefined && renderedLineCount <= tui.terminal.rows;
			if (!animationVisible || !headerInLiveViewport) return;

			frame = (frame + 1) % ORBIT_PATH.length;
			tui.requestRender();
		}, ORBIT_INTERVAL_MS);

		return {
			render(width: number): string[] {
				const minimal = theme.name === MINIMAL_THEME;
				animationVisible = width >= 34 && !minimal;
				const lines = signatureLines(owner, theme, width, frame);
				return minimal ? lines : ["", ...lines, ""];
			},
			invalidate() {},
			dispose() {
				clearInterval(timer);
			},
		};
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
	if (theme.name !== MINIMAL_THEME) return funnySpinner(theme);
	return {
		frames: ["·", "∙", "•", "∙"].map((mark) => `${theme.fg("accent", mark)} ${theme.fg("muted", "working")}`),
		intervalMs: 220,
	};
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/[\r\n\t]/g, " ")
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

type FooterUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function footerUsage(ctx: ExtensionContext): FooterUsage {
	const usage: FooterUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		usage.input += message.usage.input;
		usage.output += message.usage.output;
		usage.cacheRead += message.usage.cacheRead;
		usage.cacheWrite += message.usage.cacheWrite;
		usage.cost += message.usage.cost.total;
	}
	return usage;
}

function footerStatsLine(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider, width: number): string {
	const usage = footerUsage(ctx);
	const leftParts: string[] = [];
	if (usage.input) leftParts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage.output) leftParts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage.cacheRead) leftParts.push(theme.fg("dim", `R${formatTokens(usage.cacheRead)}`));
	if (usage.cacheWrite) leftParts.push(theme.fg("dim", `W${formatTokens(usage.cacheWrite)}`));
	if (usage.cost) leftParts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
	if (contextWindow) {
		const percent = contextUsage?.percent;
		const label = percent == null ? `?/${formatTokens(contextWindow)}` : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		const color = percent != null && percent > 90 ? "error" : percent != null && percent > 70 ? "warning" : "dim";
		leftParts.push(theme.fg(color, label));
	}

	const left = leftParts.length ? leftParts.join(" ") : theme.fg("dim", "fresh session");
	let model = ctx.model?.id ?? "no-model";
	if (footerData.getAvailableProviderCount() > 1 && ctx.model?.provider) model = `(${ctx.model.provider}) ${model}`;
	return alignFooterLine(left, theme.fg("dim", model), width);
}

type StatusChip = { priority: number; text: string };

function compactStatusChip(key: string, text: string, theme: Theme): StatusChip | undefined {
	const plain = sanitizeStatusText(text);
	if (!plain) return undefined;

	const goal = plain.match(/^goal\s+([◐◓◑◒])(?:\s+loops)?\s+(\d+\/\d+)/i);
	if (goal) return { priority: 10, text: `${theme.fg("accent", "goal")} ${theme.fg("muted", goal[1]!)} ${theme.fg("dim", goal[2]!)}` };

	if (/^(headroom|hr)\s+off$/i.test(plain)) return { priority: 20, text: theme.fg("dim", "hr off") };
	const headroom = plain.match(/^headroom\s+(?:managed|external|proxy\?)\s+·\s+saved\s+([^ ]+)\s+tok\s+·\s+([\d.]+)%\s+↓$/i) ?? plain.match(/^hr\s+(?:[mx?]\s+)?([^ ]+)\s+↓([\d.]+)%$/i);
	if (headroom) return { priority: 20, text: `${theme.fg("accent", "hr")} ${theme.fg("dim", headroom[1]!)} ${theme.fg("success", `↓${headroom[2]}%`)}` };

	if (/^(hindsight|mem)\s+off$/i.test(plain)) return { priority: 30, text: theme.fg("dim", "mem off") };
	const hindsight = plain.match(/^hindsight\s+on\s+·\s+([^·]+)\s+·\s+(working|checking|offline)$/i) ?? plain.match(/^mem(?::([^ ]+))?\s+(ok|checking|offline)$/i);
	if (hindsight) {
		const state = hindsight[2]!.toLowerCase() === "working" ? "ok" : hindsight[2]!.toLowerCase();
		const color = state === "offline" ? "error" : state === "checking" ? "warning" : "success";
		return { priority: state === "offline" ? 0 : 30, text: `${theme.fg("accent", "mem")} ${theme.fg(color, state)}` };
	}

	const mcp = plain.match(/^MCP:?\s+(\d+)\/(\d+)\s+servers?/i);
	if (mcp) {
		const ready = Number(mcp[1]);
		const total = Number(mcp[2]);
		const color = ready === total && total > 0 ? "success" : ready === 0 ? "warning" : "accent";
		return { priority: 40, text: `${theme.fg("accent", "MCP")} ${theme.fg(color, `${ready}/${total}`)}` };
	}

	const caveman = plain.match(/^caveman(?:\s+level:)?\s+(.+)$/i);
	if (caveman) return { priority: 50, text: `${theme.fg("accent", "caveman")} ${theme.fg("warning", caveman[1]!.trim())}` };

	const yolo = plain.match(/^yolo\s+(\d+)\s+running\s+agents?/i);
	if (yolo) return { priority: 60, text: `${theme.fg("accent", "yolo")} ${theme.fg("warning", `${yolo[1]} agent`)}` };

	const hasProblem = /\b(error|failed|offline|blocked)\b/i.test(plain);
	const color = hasProblem ? "error" : /\b(checking|pending|running|working)\b/i.test(plain) ? "warning" : "dim";
	return { priority: hasProblem ? 0 : 100, text: theme.fg(color, truncateToWidth(`${key}: ${plain}`, 34, "…")) };
}

function footerStatusLine(footerData: ReadonlyFooterDataProvider, theme: Theme, width: number): string | undefined {
	const chips = Array.from(footerData.getExtensionStatuses().entries())
		.map(([key, text]) => compactStatusChip(key, text, theme))
		.filter((chip): chip is StatusChip => Boolean(chip))
		.sort((a, b) => a.priority - b.priority)
		.map((chip) => chip.text);
	if (!chips.length) return undefined;
	return truncateToWidth(theme.fg("dim", "• ") + chips.join(theme.fg("dim", " · ")), width, theme.fg("dim", "…"));
}

function compactFooter(ctx: ExtensionContext) {
	return (tui: { requestRender: () => void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const cwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				const pathLine = truncateToWidth(
					theme.fg("dim", cwd) + (branch ? theme.fg("muted", ` (${branch})`) : ""),
					width,
					theme.fg("dim", "…"),
				);
				const lines = [pathLine, footerStatsLine(ctx, theme, footerData, width)];
				const statuses = footerStatusLine(footerData, theme, width);
				if (statuses) lines.push(statuses);
				return lines;
			},
		};
	};
}

export default function piSignature(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const owner = detectOwner(ctx);
		ctx.ui.setHeader(signatureHeader(owner));
		ctx.ui.setWorkingMessage("");
		ctx.ui.setWorkingIndicator(workingIndicator(ctx.ui.theme));
		if (process.env.PI_SIGNATURE_COMPACT_FOOTER !== "0") ctx.ui.setFooter(compactFooter(ctx));
		ctx.ui.setTitle(`π · ${owner} · Irfan's Pi setup`);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator(workingIndicator(ctx.ui.theme));
	});
}
