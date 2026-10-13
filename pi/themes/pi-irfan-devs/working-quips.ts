// Original progress copy, independent of the welcome artwork and SDK timers.
export const WORKING_QUIPS = [
	"Consulting rubber duck…",
	"Untangling brain noodles…",
	"Recalculating π…",
	"Negotiating with semicolons…",
	"Following the breadcrumbs…",
	"Asking bits to behave…",
	"Herding recursive cats…",
	"Bribing the syntax gremlins…",
	"Looking under the stack…",
	"Untying a promise knot…",
	"Counting on zero fingers…",
	"Polishing imaginary gears…",
	"Giving electrons a pep talk…",
	"Checking the duck's notes…",
	"Teaching brackets to hug…",
	"Chasing a stray parenthesis…",
	"Brewing decaf bytecode…",
	"Taking the scenic code path…",
	"Assembling tiny revelations…",
	"Pondering the next bit…",
	"Sorting the thought drawer…",
	"Warming up the brain cache…",
	"Measuring twice, typing once…",
	"Turning coffee into guesses…",
] as const;

export const QUIP_INTERVAL_MS = 6600;

export function workingQuip(elapsedMs: number): string {
	const tick = Math.floor(Math.max(0, elapsedMs) / QUIP_INTERVAL_MS);
	return WORKING_QUIPS[tick % WORKING_QUIPS.length]!;
}

/** Only generic native work gets humor; tools and recovery retain exact copy. */
export function isGenericWorking(kind: string, plain: string): boolean {
	return kind === "working" && /^[·∙•]\s+working$/i.test(plain.trim());
}
