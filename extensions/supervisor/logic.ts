import { isAbsolute, relative, resolve } from "node:path";

export type PublicTask = { content: string; status: string; guidance?: string };
export type PublicPhase = { name: string; tasks: PublicTask[] };
export type SupervisorModel = { provider: string; id: string; thinking?: string };

export const loadSupervisorModel = (sources: readonly unknown[]): SupervisorModel | undefined => {
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
	const merged: Partial<SupervisorModel> = {};
	for (const source of [...sources].reverse()) {
		if (!source || typeof source !== "object") continue;
		const section = (source as any).supervisor;
		const model = section?.model;
		if (typeof model?.provider === "string" && model.provider.trim())
			merged.provider = model.provider.trim();
		if (typeof model?.id === "string" && model.id.trim()) merged.id = model.id.trim();
		if (thinkingLevels.includes(model?.thinking)) merged.thinking = model.thinking;
	}
	return merged.provider && merged.id ? (merged as SupervisorModel) : undefined;
};

export const newlyCompletedTrackedTasks = (
	previous: readonly any[] | ReadonlyMap<string, string>,
	current: readonly any[],
	tracked: readonly any[],
) => {
	const flatten = (phases: readonly any[]) =>
		phases.flatMap((phase) =>
			(phase.tasks ?? []).map((task: any) => ({ phase: phase.name, task })),
		);
	const oldStatuses =
		previous instanceof Map
			? previous
			: new Map(
					flatten(previous).map(({ phase, task }) => [
						`${phase}\u0000${task.content}`,
						task.status,
					]),
				);
	const trackedKeys = new Set(tracked.map((task) => task.content));
	return flatten(current)
		.filter(
			({ phase, task }) =>
				trackedKeys.has(task.content) &&
				task.status === "completed" &&
				oldStatuses.get(`${phase}\u0000${task.content}`) !== "completed",
		)
		.map(({ task }) => task);
};
export const snapshotTodoStatuses = (phases: readonly any[]) =>
	new Map(
		phases.flatMap((phase) =>
			(phase.tasks ?? []).map((task: any) => [
				`${phase.name}\u0000${task.content}`,
				String(task.status ?? "pending"),
			]),
		),
	);

export const isPathWithinCwd = (cwd: string, target: string) => {
	const base = resolve(cwd),
		resolved = resolve(base, target || ".");
	const rel = relative(base, resolved);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const ACTIONS =
	/\b(implement|build|create|refactor|migrate|debug|fix|deploy|upgrade|remove|delete|add|update|test|verify|document|rewrite)\b/gi;
export const gated = (s: string) => {
	const normalized = s.trim();
	if (normalized.length > 500) return true;
	const actions = [...normalized.matchAll(ACTIONS)].map((m) => m[0].toLowerCase());
	if (actions.length >= 2) return true;
	return /\b(security|authentication|authorization|credentials?|payments?|production|data loss|destructive|migration|architecture|cross[- ]cutting|multiple|several|across)\b/i.test(
		normalized,
	);
};
export const renderPublicTodo = (phases: readonly any[]) =>
	phases.map((phase) => ({
		name: String(phase.name ?? "Todo"),
		tasks: (phase.tasks ?? []).map((task: any) => ({
			content: String(task.content ?? ""),
			guidance: typeof task.guidance === "string" ? task.guidance : undefined,
			status: String(task.status ?? "pending"),
		})),
	}));
export const publicTodoPrompt = (phases: readonly any[], systemPrompt = "") =>
	`${systemPrompt}\n\n## Active supervised Todo (public worker guidance)\n${JSON.stringify(renderPublicTodo(phases), null, 2)}\nUse this plan to guide the task and keep the Todo current. Private supervisor context is not part of this plan.`;
export const continuationPrompt = (tasks: readonly any[]) =>
	tasks
		.map((t) => `- [${t.status}] ${t.content}${t.guidance ? ` — Guidance: ${t.guidance}` : ""}`)
		.join("\n");
export const incompleteTasks = (phases: readonly any[]) =>
	phases.flatMap((phase) =>
		(phase.tasks ?? [])
			.filter((task: any) => task.status !== "completed")
			.map((task: any) => ({
				content: String(task.content ?? ""),
				guidance: typeof task.guidance === "string" ? task.guidance : undefined,
				status: String(task.status ?? "pending"),
			})),
	);
export const reopenItems = (phases: any[], indexes: unknown[]) => {
	const tasks = phases.flatMap((phase) => phase.tasks ?? []);
	let changed = false;
	for (const index of indexes)
		if (
			Number.isInteger(index) &&
			Number(index) >= 0 &&
			Number(index) < tasks.length &&
			tasks[Number(index)].status === "completed"
		) {
			tasks[Number(index)].status = "pending";
			changed = true;
		}
	return changed;
};
export const isCurrentReview = (
	reviewGeneration: number,
	currentGeneration: number,
	reviewTask: unknown,
	currentTask: unknown,
) => reviewGeneration === currentGeneration && reviewTask === currentTask;
export const requiresCheckpointFollowup = (result: any) =>
	result?.verified !== true || result?.scopeAligned === false;
export const isEnabled = (read: () => string) => {
	try {
		return JSON.parse(read()).enabled !== false;
	} catch {
		return true;
	}
};
export const persistEnabled = (write: (value: string) => void, enabled: boolean) =>
	write(JSON.stringify({ enabled }, null, 2));
export const shouldStart = (enabled: boolean, source: string | undefined, text: string) =>
	enabled && source !== "extension" && gated(text);
export const isSupervisorCommand = (text: string) => /^\/supervisor(?:\s|$)/i.test(text.trim());
export const latestUserRequest = (entries: readonly any[]) => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = entry?.type === "message" ? entry.message : entry;
		if (message?.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.filter((part: any) => part?.type === "text")
							.map((part: any) => part.text)
							.join("\n")
					: "";
		const request = text.trim();
		if (request && !isSupervisorCommand(request)) return request;
	}
	return undefined;
};
export const isRequirementFollowup = (text: string) => {
	const s = text.trim();
	if (
		!s ||
		/^(thanks|thank you|ok(?:ay)?|great|sounds good|got it|continue|yes|no)[.!\s]*$/i.test(s)
	)
		return false;
	return /\b(also|additionally|requirement|constraint|ensure|include|preserve|must|should|need to|do not|don't|change|support|add|follow[- ]?up|one more|one additional)\b/i.test(
		s,
	);
};
const titleFor = (clause: string) => {
	const words = clause
		.replace(/[^\p{L}\p{N}'-]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 10);
	const padding = ["within", "requested", "scope"];
	while (words.length < 5)
		words.push(padding[(words.length - 2 + padding.length) % padding.length]);
	return words
		.map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word))
		.join(" ");
};
export const createPlan = (request: string) => {
	const normalized = request.trim().replace(/\s+/g, " ");
	const clauses = normalized
		.split(/(?<=[.!?;])\s+|\s+(?:and then|then)\s+/i)
		.map((s) => s.replace(/^[,;\s]+|[,;\s]+$/g, ""))
		.filter((s) => s.length > 8)
		.slice(0, 5);
	const core = clauses.length > 1 ? clauses : [normalized];
	const tasks = core.map((criterion, i) => ({
		content: titleFor(criterion),
		status: "pending",
		guidance: `Specific requirement: ${criterion}. Make a focused change satisfying this criterion and keep the Todo status current.`,
		supervisorContext: `Private audit criterion ${i + 1}: inspect the relevant implementation and independent evidence. Confirm this exact requirement is met; do not rely on worker self-certification.`,
	}));
	tasks.push({
		content: "Verify Changes With Focused Project Checks",
		status: "pending",
		guidance: `Run recognized/configured tests and checks that verify: ${normalized}`,
		supervisorContext: `Audit verification for the full request: ${normalized}. Inspect test output and repository evidence independently; reopen this item if checks fail or evidence is absent.`,
	} as any);
	return [{ name: "Supervised plan", tasks }];
};
export const cloneTodo = (phases: readonly any[]) => JSON.parse(JSON.stringify(phases));
export const resolveTrackedTasks = (phases: readonly any[], tracked: readonly any[]) => {
	const all = phases.flatMap((phase: any) => phase.tasks ?? []);
	return tracked.map((original) => {
		const identity = all.find((task: any) => task === original);
		if (identity) return identity;
		const exact = all.filter(
			(task: any) => task.content === original.content && task.guidance === original.guidance,
		);
		if (exact.length === 1) return exact[0];
		const byUniqueContent = all.filter((task: any) => task.content === original.content);
		return byUniqueContent.length === 1 ? byUniqueContent[0] : original;
	});
};
export const restoreSupervisionFromTodo = (phases: any[], enabled: boolean) => {
	if (!enabled) return undefined;
	const allTasks = phases.flatMap((phase) => phase.tasks ?? []);
	if (!allTasks.some((task: any) => task.status !== "completed")) return undefined;
	const tracked = allTasks;
	const objective = tracked
		.map((task: any) => `- ${task.content}${task.guidance ? ` — ${task.guidance}` : ""}`)
		.join("\n");
	return {
		task: `Resume supervision from the current Todo:\n${objective}`,
		tracked,
	};
};
export const freshRunState = () => ({
	active: undefined as undefined,
	pendingEvidence: [] as string[],
	busy: false,
});

export const appendRequestPlan = (phases: any[], request: string) => {
	const normalized = request.trim().toLowerCase().replace(/\s+/g, " ");
	const existing = phases.flatMap((phase) => phase.tasks ?? []);
	if (
		existing.some(
			(task: any) =>
				String(task.guidance ?? "")
					.toLowerCase()
					.includes(normalized) || String(task.content ?? "").toLowerCase() === normalized,
		)
	)
		return { phases, tracked: [], added: false };
	const additions = createPlan(request);
	const tracked = additions.flatMap((phase) => phase.tasks);
	const firstIncomplete = phases.findIndex((phase) =>
		(phase.tasks ?? []).some((task: any) => task.status !== "completed"),
	);
	if (firstIncomplete >= 0) {
		const next = phases.map((phase, index) =>
			index === firstIncomplete ? { ...phase, tasks: [...(phase.tasks ?? []), ...tracked] } : phase,
		);
		return { phases: next, tracked, added: true };
	}
	return { phases: [...phases, ...additions], tracked, added: true };
};
