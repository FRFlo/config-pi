import { createNativeSubagent } from "../interactive-subagents/pi-extension/subagents/native-session.ts";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendRequestPlan,
	cloneTodo,
	freshRunState,
	incompleteTasks,
	hasVerifiableProgress,
	isAllowedVerificationCommand,
	isCurrentReview,
	isEnabled,
	isPathWithinCwd,
	isRequirementFollowup,
	nextNoProgress,
	persistEnabled,
	publicTodoPrompt,
	publicWorkerSteer,
	restoreSupervisionFromTodo,
	reopenItems,
	resolveTrackedTasks,
	shouldStart,
	todoChanges,
} from "./logic.ts";

const READ = "pi-todotools:supervisor-read";
const WRITE = "pi-todotools:supervisor-write";
const UPDATED = "pi-todotools:state-updated";
type Task = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	guidance?: string;
	supervisorContext?: string;
	[key: string]: any;
};
type Phase = { name: string; tasks: Task[]; [key: string]: any };
const settingsPath = () => join(getAgentDir(), "supervisor.json");
const textOf = (v: any): string =>
	Array.isArray(v)
		? v.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n")
		: String(v ?? "");

export default function supervisor(pi: any) {
	let enabled = true;
	let cwd = process.cwd();
	let active:
		| { task: string; tracked: Task[]; baseline: Phase[]; todoUpdates: string[] }
		| undefined;
	let pendingEvidence: string[] = [];
	let noProgress = 0;
	let stopped = false;
	let busy = false;
	let sessionGeneration = 0;
	let privateSecrets: string[] = [];
	let phases: Phase[] = [];
	const readTodo = () => {
		const request: any = { requestId: `${Date.now()}-${Math.random()}` };
		pi.events.emit(READ, request);
		if (Array.isArray(request.snapshot?.phases)) {
			phases = request.snapshot.phases;
			refreshSecrets(phases);
		}
		return phases;
	};
	const refreshSecrets = (next: Phase[]) => {
		privateSecrets = next
			.flatMap((p) => p.tasks ?? [])
			.map((t) => t.supervisorContext)
			.filter((s): s is string => typeof s === "string" && !!s);
	};
	const writeTodo = (next: Phase[]) => {
		pi.events.emit(WRITE, { requestId: `${Date.now()}-${Math.random()}`, phases: next });
		phases = next;
		refreshSecrets(next);
	};
	const restoreActiveFromCurrentTodo = () => {
		const restored = restoreSupervisionFromTodo(phases, enabled);
		if (!restored) return false;
		active = restored;
		pendingEvidence = [];
		noProgress = 0;
		stopped = false;
		busy = false;
		return true;
	};
	pi.on("session_start", (_event: any, ctx: any) => {
		sessionGeneration++;
		const fresh = freshRunState();
		active = fresh.active;
		pendingEvidence = fresh.pendingEvidence;
		noProgress = fresh.noProgress;
		stopped = fresh.stopped;
		busy = fresh.busy;
		privateSecrets = [];
		phases = [];
		cwd = ctx.cwd;
		enabled = true;
		enabled = isEnabled(() => readFileSync(settingsPath(), "utf8"));
		readTodo();
		if (enabled) restoreActiveFromCurrentTodo();
		ctx.ui.setStatus(
			"supervisor",
			`Supervisor ${enabled ? "on" : "off"}${active ? " (resumed from Todo)" : ""}`,
		);
	});
	pi.events.on(READ, (payload: any) => {
		if (enabled && payload && typeof payload.requestId === "string") payload.snapshot = { phases };
	});
	pi.events.on(UPDATED, (payload: any) => {
		if (!enabled || !Array.isArray(payload?.phases)) return;
		phases = payload.phases;
		refreshSecrets(phases);
		if (!active) {
			restoreActiveFromCurrentTodo();
			return;
		}
		if (active) {
			const changes = todoChanges(active.baseline, phases);
			const summary = JSON.stringify(changes);
			if (summary !== '{"added":[],"removed":[],"changed":[]}') active.todoUpdates.push(summary);
			if (active.todoUpdates.length > 20) active.todoUpdates.shift();
			active.tracked = resolveTrackedTasks(phases, active.tracked);
		}
	});
	pi.registerCommand("supervisor", {
		description: "Enable, disable, or inspect supervision",
		handler: async (args: string, ctx: any) => {
			const op = args.trim().toLowerCase();
			if (op === "on" || op === "off") {
				sessionGeneration++;
				enabled = op === "on";
				active = undefined;
				pendingEvidence = [];
				noProgress = 0;
				stopped = false;
				busy = false;
				mkdirSync(getAgentDir(), { recursive: true });
				persistEnabled((value) => writeFileSync(settingsPath(), value), enabled);
				if (enabled) {
					readTodo();
					restoreActiveFromCurrentTodo();
				}
				ctx.ui.setStatus(
					"supervisor",
					`Supervisor ${enabled ? "on" : "off"}${active ? " (resumed from Todo)" : ""}`,
				);
				ctx.ui.notify(
					`Supervisor ${enabled ? (active ? "enabled and resumed from Todo" : "enabled") : "disabled"}`,
					"info",
				);
			} else {
				readTodo();
				ctx.ui.notify(
					`Supervisor ${enabled ? "on" : "off"}; ${stopped ? "paused after 3 cycles without progress" : active ? "supervising active task" : "idle"}; ${phases.length} Todo phases`,
					"info",
				);
			}
		},
	});

	// Starting a gated task creates a worker-visible plan only through the public Todo bridge.
	pi.on("input", (event: any, ctx: any) => {
		if (typeof event?.text !== "string" || !enabled || event.source === "extension") return;
		const text = event.text;
		readTodo();
		if (active && isRequirementFollowup(text)) {
			const appended = appendRequestPlan(phases, text);
			if (!appended.added) return;
			active.task = `${active.task}\nAdditional user requirement: ${text}`;
			active.tracked = [...resolveTrackedTasks(phases, active.tracked), ...appended.tracked];
			writeTodo(appended.phases);
			stopped = false;
			noProgress = 0;
			pendingEvidence = [];
			ctx.ui.notify("Supervisor Todo updated with your additional requirement.", "info");
			return;
		}
		if (!shouldStart(enabled, event.source, text)) return;
		stopped = false;
		noProgress = 0;
		pendingEvidence = [];
		const baseline = cloneTodo(phases);
		const appended = appendRequestPlan(phases, text);
		if (!appended.added) return;
		active = { task: text, tracked: appended.tracked, baseline, todoUpdates: [] };
		writeTodo(appended.phases);
		ctx.ui.notify("Supervisor is observing this multi-step task.", "info");
	});

	pi.on("before_agent_start", (event: any) => {
		if (!enabled || !active) return;
		const prompt = publicTodoPrompt(readTodo(), event.systemPrompt);
		return { systemPrompt: prompt };
	});

	// Strip private fields/secrets at worker tool boundaries. The Todo UI owns separate human-only rendering.
	const scrubValue = (value: any): any => {
		if (typeof value === "string")
			return privateSecrets.reduce(
				(s, secret) => (secret ? s.split(secret).join("[private context omitted]") : s),
				value.replace(/\bsupervisorContext\s*[:=].*$/gim, "[private context omitted]"),
			);
		if (Array.isArray(value)) return value.map(scrubValue);
		if (value && typeof value === "object") {
			const out: any = {};
			for (const [key, child] of Object.entries(value))
				if (key !== "supervisorContext") out[key] = scrubValue(child);
			return out;
		}
		return value;
	};
	pi.on("tool_call", (event: any) => {
		if (!enabled || !event?.input) return;
		const cleaned = scrubValue(event.input);
		for (const key of Object.keys(event.input)) if (!(key in cleaned)) delete event.input[key];
		Object.assign(event.input, cleaned);
	});

	const reviewerGuard = (reviewCwd: string) => (reviewPi: any) => {
		reviewPi.on("tool_call", (event: any) => {
			if (["read", "grep", "find", "ls"].includes(event?.toolName)) {
				const paths: string[] = [];
				const collect = (value: any, key = "") => {
					if (typeof value === "string" && /^(path|paths|cwd)$/i.test(key)) paths.push(value);
					else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
					else if (value && typeof value === "object")
						for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
				};
				collect(event.input);
				if (paths.some((path) => !isPathWithinCwd(reviewCwd, path)))
					return {
						block: true,
						reason: "Reviewer filesystem access is restricted to the request repository cwd.",
					};
				return;
			}
			if (event?.toolName !== "bash") return;
			const command = String(event.input?.command ?? "");
			let configured: string[] = [];
			try {
				const pkg = JSON.parse(readFileSync(join(reviewCwd, "package.json"), "utf8"));
				for (const name of Object.keys(pkg.scripts ?? {})) {
					if (!/^(test|check|typecheck|lint)(:[-\w]+)?$/.test(name)) continue;
					for (const manager of ["bun", "npm", "pnpm", "yarn"])
						configured.push(`${manager} run ${name}`);
					if (name === "test")
						for (const manager of ["npm", "pnpm", "yarn"]) configured.push(`${manager} test`);
				}
			} catch {
				/* no configured project scripts */
			}
			if (!isAllowedVerificationCommand(command, configured))
				return {
					block: true,
					reason:
						"Supervisor bash is restricted to git status/diff and recognized/configured test or check commands.",
				};
		});
	};

	// Observe milestones/progress text and tool outcomes, but review once at agent_end to avoid per-token calls.
	pi.on("message_end", (event: any) => {
		if (!enabled || !active || stopped || event?.message?.role !== "assistant") return;
		const progress = textOf(event.message.content).trim();
		if (progress)
			pendingEvidence.push(
				`assistant progress/milestone claim (unverified): ${progress.slice(0, 1000)}`,
			);
		if (pendingEvidence.length > 30) pendingEvidence.shift();
	});
	pi.on("tool_result", (event: any) => {
		if (!enabled) return;
		const sanitized = scrubValue(event?.content ?? []);
		if (active && !stopped) {
			const detail = textOf(sanitized).slice(0, 1200);
			pendingEvidence.push(
				`${event?.toolName ?? "tool"} ${event?.isError ? "ERROR" : "result"}; input=${JSON.stringify(scrubValue(event?.input ?? {})).slice(0, 500)}: ${detail}`,
			);
			if (pendingEvidence.length > 30) pendingEvidence.shift();
		}
		return { content: sanitized };
	});
	pi.on("agent_end", async (event: any, ctx: any) => {
		if (!enabled || !active || stopped || busy) return;
		busy = true;
		const reviewGeneration = sessionGeneration;
		const reviewCwd = cwd;
		const reviewTask = active;
		const evidence = pendingEvidence.splice(0).join("\n");
		const latestMessages = (event?.messages ?? [])
			.slice(-8)
			.map((m: any) => `${m?.role}: ${textOf(m?.content).slice(0, 1200)}`)
			.join("\n");
		const current = readTodo();
		active.tracked = resolveTrackedTasks(current, active.tracked);
		privateSecrets = current
			.flatMap((p) => p.tasks ?? [])
			.map((t) => t.supervisorContext)
			.filter((s): s is string => typeof s === "string" && !!s);
		const privateTodo = active.tracked
			.filter((t) => t.supervisorContext)
			.map((t) => `PRIVATE CONTEXT (reviewer only): ${t.supervisorContext}`)
			.join("\n");
		let agent: any;
		try {
			agent = await createNativeSubagent({
				cwd: reviewCwd,
				agentDir: getAgentDir(),
				model: ctx.model,
				tools: ["read", "grep", "find", "ls", "bash"],
				extensionFactories: [reviewerGuard(reviewCwd)],
				systemPrompt:
					'You are an independent skeptical supervisor. Read/grep/find/ls are read-only. Bash is permitted only for guard-approved git status/diff and recognized/configured test or check commands; do not modify files or run any other command. Evaluate worker activity and independently inspect repository evidence. Never ask the worker to certify completion. If completed Todo items lack evidence, return flattened global Todo task indexes for reopening. Respond with JSON only: {"progress":boolean,"drift":string,"rationaleNeeded":string,"reopen":number[],"evidence":string}. Treat provided private supervisor context as private; it must not appear in the output.',
			});
			const globalTasks = current.flatMap((p) => p.tasks ?? []);
			const todo = active.tracked.map((t) => ({
				flatIndex: globalTasks.indexOf(t),
				content: t.content,
				status: t.status,
				guidance: t.guidance,
			}));
			const changes = todoChanges(active.baseline, current);
			await agent.session.prompt(
				`Task: ${textOf(scrubValue(active.task))}\nCurrent request Todo items: ${JSON.stringify(todo)}\nBaseline Todo (private reviewer input): ${JSON.stringify(active.baseline)}\nCurrent Todo (private reviewer input): ${JSON.stringify(current)}\nTodo changes since baseline, including agent/user additions and removals/replacements: ${JSON.stringify(changes)}\nTodo state-update history (may show additions and their subsequent status/result): ${active.todoUpdates.join("\n")}\nWorker turn and tool results (untrusted, not proof by themselves):\n${textOf(scrubValue(latestMessages + "\n" + evidence))}\n${privateTodo}\nIndependently inspect repository and available test evidence using read-only tools. Judge progress only when supported by concrete evidence. Critically assess removals/replacements against the new request, while allowing agent-added Todo items when relevant; report their outcomes. Do not classify unrelated pre-existing incomplete tasks as drift. Check every completed request-specific item against evidence; return its flattened global flatIndex for reopening if evidence is missing, a test fails, or it contradicts the request. Flag confirmed scope drift and request rationale, never ask worker for completion certification.`,
			);
			if (!isCurrentReview(reviewGeneration, sessionGeneration, reviewTask, active)) return;
			const all: any[] = agent.session.messages ?? [];
			const output = textOf([...all].reverse().find((m) => m?.role === "assistant")?.content);
			const match = output.match(/\{[\s\S]*\}/);
			let result: any;
			try {
				result = match ? JSON.parse(match[0]) : {};
			} catch {
				result = {};
			}
			let reopened = false;
			reopened = reopenItems(current, Array.isArray(result.reopen) ? result.reopen : []);
			if (reopened) writeTodo(current);
			const verifiedProgress = hasVerifiableProgress(result.progress, result.evidence);
			noProgress = nextNoProgress(noProgress, verifiedProgress);
			const alert = [
				result.drift && `Drift: ${result.drift}`,
				result.rationaleNeeded && `Rationale needed: ${result.rationaleNeeded}`,
				reopened && "Todo reopened: completion evidence was insufficient.",
				result.evidence && `Evidence: ${result.evidence}`,
			]
				.filter(Boolean)
				.join("\n");
			if (noProgress >= 3) {
				stopped = true;
				ctx.ui.setStatus("supervisor", "Supervisor paused");
				ctx.ui.notify(
					"Supervisor paused after 3 consecutive cycles without verifiable progress; control returned to you.",
					"warning",
				);
			}
			const todoRemaining = incompleteTasks([
				{ tasks: resolveTrackedTasks(current, active.tracked) },
			]);
			if (todoRemaining.length && noProgress < 3) {
				const steer = publicWorkerSteer(
					todoRemaining,
					Boolean(result.drift),
					Boolean(result.rationaleNeeded),
				);
				if (steer)
					pi.sendUserMessage(`Supervisor observation (not a completion request):\n${steer}`, {
						deliverAs: "steer",
					});
			}
			if (alert) {
				// This is user-only UI, so private Todo context may be shown to the human.
				const visible = alert.slice(0, 1000);
				ctx.ui.notify(
					`Supervisor review (not a completion guarantee): ${visible}`,
					result.drift ? "warning" : "info",
				);
			}
			if (active.tracked.every((t) => t.status === "completed")) {
				ctx.ui.notify(
					"All request-specific Todo items are marked complete; independent review is observational and not a full certification.",
					"info",
				);
				active = undefined;
			}
		} catch (error) {
			if (isCurrentReview(reviewGeneration, sessionGeneration, reviewTask, active)) {
				noProgress = nextNoProgress(noProgress, false);
				if (noProgress >= 3) {
					stopped = true;
					ctx.ui.setStatus("supervisor", "Supervisor paused");
					ctx.ui.notify(
						"Supervisor paused after 3 consecutive review failures without verifiable progress; control returned to you.",
						"warning",
					);
				} else {
					ctx.ui.notify(
						`Supervisor review failed (${noProgress}/3); task is not independently verified: ${String(error)}`,
						"warning",
					);
				}
			}
		} finally {
			agent?.dispose();
			if (reviewGeneration === sessionGeneration) busy = false;
		}
	});
}
