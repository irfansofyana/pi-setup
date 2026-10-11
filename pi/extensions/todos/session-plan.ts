/** Session plans are independent of the durable project todo files. */
export const PLAN_ENTRY = "pi-setup-todo-plan";
export const PLAN_STATUSES = ["pending", "in_progress", "blocked", "completed"] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];
export interface PlanStep {
	id: string;
	title: string;
	body: string;
	status: PlanStatus;
	note: string;
}
export interface SessionPlan {
	version: 1;
	revision: number;
	nextId: number;
	steps: PlanStep[];
}
export interface PlanMutation {
	action: string;
	id?: string;
	title?: string;
	body?: string;
	status?: string;
	note?: string;
	order?: string[];
	expectedRevision?: number;
}
export function emptyPlan(): SessionPlan {
	return { version: 1, revision: 0, nextId: 1, steps: [] };
}

function boundedText(value: unknown, name: string, limit: number, required = false): string {
	if (typeof value !== "string" || value.length > limit || (required && !value.trim())) {
		throw new Error(`${name} must be ${required ? "non-empty " : ""}text of at most ${limit} characters`);
	}
	return value.trim();
}

/** Pure, atomic mutations shared by the tool and manual manager. */
export function mutatePlan(current: SessionPlan, change: PlanMutation): SessionPlan {
	if (change.expectedRevision !== undefined && change.expectedRevision !== current.revision) {
		throw new Error("Plan changed while you were editing. Open the step again to review the latest version.");
	}
	const plan = structuredClone(current);
	if (change.action === "create") {
		if (plan.steps.length >= 100) throw new Error("Session plan is limited to 100 steps.");
		plan.steps.push({ id: `PLAN-${plan.nextId++}`, title: boundedText(change.title, "title", 200, true), body: "", status: "pending", note: "" });
	} else if (change.action === "reorder") {
		const order = change.order;
		if (!order || order.length !== plan.steps.length || new Set(order).size !== order.length || order.some(id => !plan.steps.some(step => step.id === id))) {
			throw new Error("order must contain every session step id exactly once");
		}
		plan.steps = order.map(id => plan.steps.find(step => step.id === id)!);
	} else if (!["update", "append", "delete"].includes(change.action)) {
		throw new Error(`Session plans do not support ${change.action}. Use create, update, append, delete or reorder.`);
	}
	if (["create", "update", "append", "delete"].includes(change.action)) {
		const step = change.action === "create" ? plan.steps.at(-1)! : plan.steps.find(step => step.id === change.id);
		if (!step) throw new Error("Session step not found; pass its PLAN-<number> id.");
		if (change.action === "delete") plan.steps = plan.steps.filter(item => item.id !== step.id);
		else {
			if (change.title !== undefined) step.title = boundedText(change.title, "title", 200, true);
			if (change.body !== undefined) step.body = boundedText(change.action === "append" ? `${step.body}\n\n${change.body}` : change.body, "body", 20_000);
			if (change.status !== undefined) {
				if (!PLAN_STATUSES.includes(change.status as PlanStatus)) throw new Error("Use pending, in_progress, blocked or completed for session status.");
				if (step.status !== change.status) step.note = "";
				step.status = change.status as PlanStatus;
			}
			if (change.note !== undefined) step.note = boundedText(change.note, "note", 1000);
			if (step.status === "blocked" && !step.note) throw new Error("A blocked step needs a note explaining what it is waiting for.");
		}
	}
	if (JSON.stringify(plan).length > 200_000) throw new Error("Session plan is too large; shorten step descriptions.");
	plan.revision++;
	return plan;
}

function isPlan(value: unknown): value is SessionPlan {
	if (!value || typeof value !== "object") return false;
	const plan = value as SessionPlan;
	return plan.version === 1 && Number.isSafeInteger(plan.revision) && plan.revision >= 0 && Number.isSafeInteger(plan.nextId) && plan.nextId > 0 &&
		Array.isArray(plan.steps) && plan.steps.length <= 100 && new Set(plan.steps.map(step => step?.id)).size === plan.steps.length &&
		plan.steps.every(step => step && /^PLAN-[1-9]\d*$/.test(step.id) && Number(step.id.slice(5)) < plan.nextId &&
			typeof step.title === "string" && !!step.title.trim() && step.title.length <= 200 &&
			typeof step.body === "string" && step.body.length <= 20_000 && typeof step.note === "string" && step.note.length <= 1000 &&
			PLAN_STATUSES.includes(step.status) && (step.status !== "blocked" || !!step.note.trim()));
}

/** Only use the active branch. Failed/foreign tool results never replace state. */
export function restorePlan(entries: readonly unknown[]): SessionPlan {
	let plan = emptyPlan();
	for (const raw of entries) {
		const entry = raw as { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; isError?: boolean; details?: { scope?: string; plan?: unknown; error?: string } } };
		const message = entry?.message;
		const value = entry?.type === "custom" && entry.customType === PLAN_ENTRY ? entry.data :
			entry?.type === "message" && message?.role === "toolResult" && message.toolName === "todo" && !message.isError && message.details?.scope === "session" && !message.details.error ? message.details.plan : undefined;
		if (isPlan(value) && value.revision >= plan.revision) plan = structuredClone(value);
	}
	return plan;
}
