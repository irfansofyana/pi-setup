import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { conciseError, priorCallsWarning } from "./codemode-errors.ts";

const THEME = "pi-irfan-devs";
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callsFrom(details: unknown): Record<string, unknown>[] {
	return record(details) && Array.isArray(details.calls)
		? details.calls.filter((call): call is Record<string, unknown> => record(call) && typeof call.name === "string") : [];
}

function plain(value: string): string {
	return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function duration(ms: number | undefined): string {
	return ms == null ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Keep original caches and lifecycle separate from compact Text components. */
export function compactCodemodeRenderers(base: ToolRenderers | undefined): ToolRenderers {
	type Delegate = { started: boolean; call?: Component; result?: Component };
	const delegates = new WeakMap<object, Delegate>();
	const delegateFor = (state: object): Delegate => {
		let delegate = delegates.get(state);
		if (!delegate) { delegate = { started: false }; delegates.set(state, delegate); }
		return delegate;
	};
	return {
		// Preserve native shell and third-party ownership, including on live theme changes.
		// The palette makes this small surface neutral; no dynamic shell/core patch needed.
		renderShell: base?.renderShell ?? "default",
		renderCall(args, theme, context) {
			const delegate = delegateFor(context.state);
			const showNative = theme.name !== THEME || context.expanded;
			if (showNative) delegate.started = true;
			// Once native rendering starts, keep forwarding updates through completion.
			// Its timer/cache cleanup must run even after the user collapses this row.
			if (delegate.started && base?.renderCall) {
				delegate.call = base.renderCall(args, theme, { ...context, lastComponent: delegate.call });
			}
			if (showNative) return delegate.call
				?? new Text(`codemode\n${typeof args?.code === "string" ? plain(args.code) : ""}`, 0, 0);
			const failed = context.isError;
			const running = context.executionStarted && context.isPartial;
			const completed = !context.isPartial;
			const mark = failed ? "✗" : running ? "·" : completed ? "✓" : "·";
			const label = failed ? "failed" : running ? "running" : completed ? "completed" : "preparing";
			const elapsed = duration(context.durationMs);
			return new Text(
				theme.fg(failed ? "error" : running ? "accent" : "success", mark) + " "
				+ theme.fg(failed ? "error" : "toolTitle", "codemode") + theme.fg("dim", ` · ${label}${elapsed ? ` · ${elapsed}` : ""}`),
				0, 0,
			);
		},
		renderResult(result, options, theme, context) {
			const delegate = delegateFor(context.state);
			const showNative = theme.name !== THEME || options.expanded;
			if (showNative) delegate.started = true;
			if (delegate.started && base?.renderResult) {
				delegate.result = base.renderResult(result, options, theme, { ...context, lastComponent: delegate.result });
			}
			if (showNative) return delegate.result
				?? new Text(result.content.filter(part => part.type === "text").map(part => plain(part.text)).join("\n"), 0, 0);
			const calls = callsFrom(result.details);
			const failed = calls.filter(call => call.status === "error");
			const cancelled = calls.filter(call => call.status === "cancelled");
			const running = calls.filter(call => call.status === "running");
			const summary = [
				calls.length ? `${calls.length} call${calls.length === 1 ? "" : "s"}` : "Output",
				failed.length ? `${failed.length} failed` : "",
				cancelled.length ? `${cancelled.length} cancelled` : "",
				running.length ? `${running.length} running` : "",
				"expand for details",
			].filter(Boolean).join(" · ");
			const lines: string[] = [];
			let priorWarning: string | undefined;
			if (context.isError) {
				const output = result.content.filter(part => part.type === "text" && !SCRIPT_HEADER.test(part.text))
					.map(part => plain(part.text)).join("\n").trim();
				lines.push(theme.fg("error", truncateToWidth(conciseError(output), 140, "…")));
				priorWarning = priorCallsWarning(output, calls.length);
			}
			// Caught nested errors still matter; stacks remain available on expansion.
			for (const call of failed.slice(0, 2)) {
				const message = typeof call.error === "string" ? call.error : "tool failed";
				lines.push(theme.fg("error", truncateToWidth(`${plain(String(call.name)).replace(/\s+/g, " ")}: ${conciseError(plain(message))}`, 140, "…")));
			}
			if (priorWarning) lines.push(theme.fg("warning", priorWarning));
			lines.push(theme.fg("dim", summary));
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}

export function registerCompactCodemode(pi: ExtensionAPI): void {
	// Older Pi hosts keep their native renderer; package minimum need not change.
	if (typeof pi.registerToolRenderer !== "function") return;
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "codemode" || !base?.renderCall || !base?.renderResult || base.renderShell === "self") return base;
		return compactCodemodeRenderers(base);
	});
}
