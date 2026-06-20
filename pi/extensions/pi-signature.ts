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
	"real devs test in prod",
	"prod is my staging",
	"works on my prod",
	"unit tests are vibes",
	"QA? you mean users?",
	"LGTM from orbit",
	"ship now, pray later",
	"hotfix-driven dev",
	"CI failed emotionally",
	"lint chose violence",
	"git blame my intern",
	"merge conflict cardio",
	"regex ate the ticket",
	"null broke parole",
	"undefined has entered",
	"one more console.log",
	"TODO is product plan",
	"legacy means revenue",
	"cache invalidates me",
	"YAML wants a sacrifice",
	"JSON comma missing",
	"npm brought friends",
	"docker lied again",
	"localhost gaslighting",
	"rollback is feature",
	"bug has stakeholder",
	"feature has bugs",
	"Friday deploy enjoyer",
	"prod heard you type",
	"logs say skill issue",
	"stack overflow oracle",
	"rubber duck resigned",
	"types filing lawsuit",
	"compiler needs proof",
	"API ghosted again",
	"DB says maybe later",
	"cron slept through it",
	"state went feral",
	"race condition won",
	"thread needs therapy",
	"memory leak premium",
	"pointer points at you",
	"semicolons unionized",
	"tabs versus spaces war",
	"branch has side quests",
	"commit message: trust",
	"works until observed",
	"cloud is someone else's bug",
	"deadline-driven design",
	"deploy gods demand logs",
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

function funnySpinner(theme: Theme): WorkingIndicatorOptions {
	const orbit = ["·π·", "∙π∙", "•π•", "✦π✦", "•π•", "∙π∙"];
	const colors = ["dim", "muted", "warning", "accent", "warning", "muted"] as const;
	return {
		frames: WORKING_JOKES.map((joke, index) => {
			const frame = orbit[index % orbit.length]!;
			const color = colors[index % colors.length]!;
			return `${theme.fg(color, frame)} ${theme.fg("muted", joke)}`;
		}),
		intervalMs: 900,
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
}
