import { isAbsolute, relative, resolve } from "node:path";

export type PublicTask = { content: string; status: string; guidance?: string };
export type PublicPhase = { name: string; tasks: PublicTask[] };

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
export const publicWorkerSteer = (
	tasks: readonly any[],
	hasDrift: boolean,
	needsRationale: boolean,
) => {
	const pending = continuationPrompt(tasks);
	return [
		hasDrift ? "Keep the work within the public Todo scope; correct any out-of-scope changes." : "",
		needsRationale
			? "If a decision is not specified by the public Todo or guidance, briefly explain your rationale in the next progress update."
			: "",
		pending ? `Continue or correct these public Todo items:\n${pending}` : "",
	]
		.filter(Boolean)
		.join("\n");
};
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
export const hasVerifiableProgress = (progress: unknown, evidence: unknown) =>
	progress === true && typeof evidence === "string" && evidence.trim().length > 0;
export const isCurrentReview = (
	reviewGeneration: number,
	currentGeneration: number,
	reviewTask: unknown,
	currentTask: unknown,
) => reviewGeneration === currentGeneration && reviewTask === currentTask;
export const nextNoProgress = (cycles: number, hasVerifiableProgress: boolean) =>
	hasVerifiableProgress ? 0 : cycles + 1;
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
		supervisorContext: `Private audit criterion ${i + 1}: inspect the relevant implementation and independent evidence. Confirm this exact requirement is met and scope is controlled; do not rely on worker self-certification.`,
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
export const todoChanges = (baseline: readonly any[], current: readonly any[]) => {
	const flatten = (phases: readonly any[]) =>
		phases.flatMap((phase: any) =>
			(phase.tasks ?? []).map((task: any) => ({ phase: phase.name, task })),
		);
	const before = flatten(baseline),
		after = flatten(current);
	const key = (entry: any) => `${entry.phase}\u0000${entry.task.content}`;
	const oldMap = new Map(before.map((entry) => [key(entry), entry.task]));
	const newMap = new Map(after.map((entry) => [key(entry), entry.task]));
	const removed = before
		.filter((entry) => !newMap.has(key(entry)))
		.map((entry) => ({ phase: entry.phase, ...entry.task }));
	const added = after
		.filter((entry) => !oldMap.has(key(entry)))
		.map((entry) => ({ phase: entry.phase, ...entry.task }));
	const changed = after
		.filter(
			(entry) =>
				oldMap.has(key(entry)) &&
				JSON.stringify(oldMap.get(key(entry))) !== JSON.stringify(entry.task),
		)
		.map((entry) => ({ phase: entry.phase, before: oldMap.get(key(entry)), after: entry.task }));
	return { added, removed, changed };
};
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
		baseline: cloneTodo(phases),
		todoUpdates: [],
	};
};
export const freshRunState = () => ({
	active: undefined as undefined,
	pendingEvidence: [] as string[],
	noProgress: 0,
	stopped: false,
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

// No shell operators, substitutions, redirections, or compound commands. Tests/checks must be allowlisted explicitly.
export const isAllowedVerificationCommand = (command: string, configuredScripts: string[] = []) => {
	const cmd = command.trim();
	if (
		!cmd ||
		/[;&|`$<>\n\r]/.test(cmd) ||
		/\b(sudo|rm|mv|cp|curl|wget|git\s+(?!status|diff))\b/i.test(cmd)
	)
		return false;
	if (
		/^git status(?: --short)?$/.test(cmd) ||
		/^git diff(?: --stat| --check)?$/.test(cmd) ||
		/^git diff -- [\w./-]+$/.test(cmd)
	)
		return true;
	const standard = [
		"bun test",
		"bun run test",
		"bun run check",
		"bun run typecheck",
		"bun run lint",
		"npm test",
		"npm run test",
		"npm run check",
		"npm run typecheck",
		"npm run lint",
		"pnpm test",
		"pnpm run test",
		"pnpm run check",
		"pnpm run typecheck",
		"pnpm run lint",
		"yarn test",
		"yarn run test",
		"yarn run check",
		"yarn run typecheck",
		"yarn run lint",
	];
	return standard.includes(cmd) || configuredScripts.includes(cmd);
};
