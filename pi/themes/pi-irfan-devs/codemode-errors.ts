const PRIOR_CALLS = "Tool calls made before the failure (they are not undone):";

/** Presentation only: callers keep the original result for expanded rendering. */
export function conciseError(output: string): string {
	const lines = output.split(/\r?\n/).map(line => line.trim());
	// Prefer the runtime's failure over script output printed before it failed.
	const scriptError = lines.findLastIndex(line => /^Script error:/i.test(line));
	const candidates = scriptError >= 0 ? lines.slice(scriptError) : lines;
	const first = candidates.find(line => line && !line.startsWith(PRIOR_CALLS)) ?? "";
	return first.replace(/^Script error:\s*/i, "").replace(/^Error:\s*/, "").trim() || "Script failed";
}

export function priorCallsWarning(output: string, recordedCalls: number): string | undefined {
	if (recordedCalls > 0) {
		return `${recordedCalls} prior call${recordedCalls === 1 ? "" : "s"} · changes not undone`;
	}
	return output.includes(PRIOR_CALLS) ? "Prior calls not undone · expand for details" : undefined;
}
