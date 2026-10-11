import { Text, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

type Host = { terminal: { rows: number }; requestRender(): void };
type MouseResult = TuiMouseEventResult | undefined;
export interface ActivitySection {
	id: "todos" | "subagents";
	state(): { rows: number; focused?: boolean; attention?: boolean };
	render(width: number, maxRows: number): string[];
	handleMouse?(event: TuiMouseEvent): MouseResult;
}
type Entry = { token: object; section: ActivitySection };
type Group = { entries: Map<string, Entry> };
// Share only presentation, scoped to the exact terminal host. Pi may load this module
// once per extension; no extension state, editor hooks or runtime authority lives here.
const key = Symbol.for("pi-setup.activity-dock.v1");
const globals = globalThis as typeof globalThis & { [key]?: WeakMap<object, Group> };
const groups = globals[key] ??= new WeakMap<object, Group>();

/** Each extension owns its widget registration. One component paints their combined
 * sections; the others render zero rows. Unloading either leaves the other usable. */
export function createActivityDock(host: Host, section: ActivitySection) {
	let group = groups.get(host);
	if (!group) { group = { entries: new Map() }; groups.set(host, group); }
	const registry = group;
	const entry = { token: {}, section };
	registry.entries.set(section.id, entry);
	host.requestRender();
	let disposed = false;
	let hitRows: { entry: Entry; start: number; end: number }[] = [];
	const fallback = (id: string) => id === "todos" ? "/todos plan" : "/agents tasks";
	return new class extends Text {
		render(width: number): string[] {
			hitRows = [];
			if (disposed || width < 1 || (registry.entries.get("todos") ?? registry.entries.get("subagents")) !== entry) return [];
			const sections = [...registry.entries.values()].sort((a, b) => Number(a.section.id === "subagents") - Number(b.section.id === "subagents"));
			const states = sections.map(item => {
				try { return item.section.state(); } catch { return { rows: 1 }; }
			});
			const focused = states.findIndex(state => state.focused);
			const total = Math.max(1, Math.min(focused >= 0 ? 10 : 6, (host.terminal.rows || 24) - 10));
			const wanted = states.map(state => Number.isFinite(state.rows) ? Math.max(0, Math.min(10, Math.floor(state.rows))) : 1);
			const budgets = wanted.map(() => 0);
			const priority = sections.map((_, i) => i).sort((a, b) => Number(b === focused) - Number(a === focused) || Number(!!states[b].attention) - Number(!!states[a].attention) || a - b);
			let left = total;
			for (const i of priority) if (wanted[i] && left) { budgets[i] = 1; left--; }
			if (focused >= 0) {
				const extra = Math.min(left, wanted[focused] - budgets[focused]);
				budgets[focused] += extra; left -= extra;
			}
			while (left > 0) {
				let changed = false;
				for (const i of priority) if (budgets[i] < wanted[i] && left) { budgets[i]++; left--; changed = true; }
				if (!changed) break;
			}
			const lines: string[] = [];
			for (const [i, item] of sections.entries()) {
				if (!budgets[i]) continue;
				let rows: string[];
				try { rows = item.section.render(width, budgets[i]).slice(0, budgets[i]).map(line => truncateToWidth(line, width, "")); }
				catch { rows = [truncateToWidth(fallback(item.section.id), width, "")]; }
				hitRows.push({ entry: item, start: lines.length, end: lines.length + rows.length });
				lines.push(...rows);
			}
			this.setText(lines.join("\n"));
			return super.render(width);
		}
		handleMouse(event: TuiMouseEvent): MouseResult {
			if (disposed || !Number.isInteger(event.y) || (registry.entries.get("todos") ?? registry.entries.get("subagents")) !== entry) return;
			const hit = hitRows.find(row => event.y >= row.start && event.y < row.end);
			if (!hit || registry.entries.get(hit.entry.section.id) !== hit.entry) return;
			try { return hit.entry.section.handleMouse?.({ ...event, y: event.y - hit.start }); }
			catch { return; }
		}
		dispose(): void {
			if (disposed) return;
			disposed = true; hitRows = [];
			if (registry.entries.get(section.id) === entry) registry.entries.delete(section.id);
			if (!registry.entries.size && groups.get(host) === registry) groups.delete(host);
			host.requestRender();
		}
	}("", 0, 0);
}
