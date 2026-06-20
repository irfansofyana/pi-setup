import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const AUTHOR_CREDIT = "crafted from Irfan's Pi setup";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

type Rgb = [number, number, number];

const PALETTE: Rgb[] = [
	[254, 128, 25],
	[250, 189, 47],
	[251, 241, 199],
	[250, 189, 47],
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

function centerPlain(line: string, width: number): string {
	return center(truncateToWidth(line, width, ""), width);
}

function signatureLines(owner: string, theme: Theme, width: number): string[] {
	const title = `${BOLD}${theme.fg("accent", owner)}${RESET}`;
	const credit = theme.fg("muted", AUTHOR_CREDIT);

	if (width < 34) {
		const mark = theme.bold(theme.fg("accent", "π"));
		return [center(`${mark} ${title}`, width), center(credit, width)];
	}

	return [
		...PI_LINES.map((line, row) => gradientText(centerPlain(line, width), row * 0.025)),
		center(title, width),
		center(credit, width),
	];
}

function signatureHeader(owner: string) {
	return (_tui: unknown, theme: Theme) => ({
		render(width: number): string[] {
			return ["", ...signatureLines(owner, theme, width), ""];
		},
		invalidate() {},
	});
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

export default function piSignature(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const owner = detectOwner(ctx);
		ctx.ui.setHeader(signatureHeader(owner));
		ctx.ui.setWorkingMessage("");
		ctx.ui.setWorkingIndicator(funnySpinner(ctx.ui.theme));
		ctx.ui.setTitle(`π · ${owner} · Irfan's Pi setup`);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator(funnySpinner(ctx.ui.theme));
	});
}
