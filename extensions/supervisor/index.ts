import { randomUUID } from "node:crypto";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendRequestPlan,
	freshRunState,
	isEnabledForSession,
	newlyCompletedTrackedTasks,
	isCurrentReview,
	isRequirementFollowup,
	loadSupervisorModel,
	latestUserRequest,
	publicTodoPrompt,
	requiresCheckpointFollowup,
	restoreSupervisionFromTodo,
	reopenItems,
	resolveTrackedTasks,
	shouldStart,
	snapshotTodoStatuses,
} from "./logic.ts";

const READ = "pi-todotools:supervisor-read";
const WRITE = "pi-todotools:supervisor-write";
const UPDATED = "pi-todotools:state-updated";
const ENABLED_ENTRY = "supervisor.enabled";
type Task = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	guidance?: string;
	supervisorContext?: string;
	[key: string]: any;
};
type Phase = { name: string; tasks: Task[]; [key: string]: any };
const textOf = (v: any): string =>
	Array.isArray(v)
		? v.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n")
		: String(v ?? "");

export default function supervisor(pi: any) {
	let enabled = false;
	let cwd = process.cwd();
	let active: { task: string; tracked: Task[] } | undefined;
	let pendingEvidence: string[] = [];
	let reviewQueue: Task[] = [];
	let followupQueue: Task[] = [];
	let supervisorModel: any;
	let busy = false;
	let sessionGeneration = 0;
	let privateSecrets: string[] = [];
	let phases: Phase[] = [];
	let todoStatuses = new Map<string, string>();
	const requestRpc = (channel: string, payload: Record<string, unknown>) =>
		new Promise<any>((resolve, reject) => {
			const requestId = randomUUID();
			const replyChannel = `${channel}:reply:${requestId}`;
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for ${channel}`));
			}, 15_000);
			const unsubscribe = pi.events.on(replyChannel, (reply: any) => {
				clearTimeout(timeout);
				unsubscribe();
				if (!reply?.success) reject(new Error(reply?.error ?? `${channel} failed`));
				else resolve(reply.data);
			});
			pi.events.emit(channel, { ...payload, requestId });
		});
	const runSubagent = async (
		type: string,
		prompt: string,
		description: string,
		options: Record<string, unknown>,
	) => {
		let agentId: string | undefined;
		let earlyResult: any;
		let settled = false;
		let resolveResult!: (event: any) => void;
		let rejectResult!: (error: Error) => void;
		let resultTimeout: ReturnType<typeof setTimeout>;
		const resultPromise = new Promise<any>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const finish = (event: any) => {
			if (settled) return;
			settled = true;
			clearTimeout(resultTimeout);
			unsubscribeCompleted();
			unsubscribeFailed();
			// We report the result ourselves, so suppress the extension's
			// duplicate completion notification.
			pi.events.emit("subagents:rpc:consume", {
				requestId: randomUUID(),
				agentId: event.id,
			});
			if (event.status === "error" || event.error) {
				rejectResult(new Error(event.error || event.result || "Subagent failed"));
			} else {
				resolveResult(event);
			}
		};
		const onSettled = (event: any) => {
			if (event?.description !== description) return;
			if (!agentId) earlyResult = event;
			else if (event.id === agentId) finish(event);
		};
		const unsubscribeCompleted = pi.events.on("subagents:completed", onSettled);
		const unsubscribeFailed = pi.events.on("subagents:failed", onSettled);
		resultTimeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribeCompleted();
			unsubscribeFailed();
			if (agentId) {
				pi.events.emit("subagents:rpc:stop", {
					requestId: randomUUID(),
					agentId,
				});
			}
			rejectResult(new Error(`Timed out waiting for ${description}`));
		}, 120_000);
		try {
			const spawned = await requestRpc("subagents:rpc:spawn", {
				type,
				prompt,
				options: { description, ...options },
			});
			agentId = spawned?.id;
			if (!agentId) throw new Error("Subagent RPC returned no agent id");
			if (earlyResult?.id === agentId) finish(earlyResult);
			const result = await resultPromise;
			return typeof result.result === "string" ? result.result : "";
		} catch (error) {
			clearTimeout(resultTimeout);
			unsubscribeCompleted();
			unsubscribeFailed();
			throw error;
		}
	};
	const readConfigFile = (path: string) => {
		try {
			return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
		} catch {
			return undefined;
		}
	};
	const loadModel = () => {
		const agentDir = getAgentDir();
		supervisorModel = loadSupervisorModel([
			readConfigFile(join(cwd, ".pi", "preferences.json")),
			readConfigFile(join(cwd, ".pi", "settings.json")),
			readConfigFile(join(agentDir, "preferences.json")),
			readConfigFile(join(agentDir, "settings.json")),
		]);
	};
	const frameRequest = async (request: string, ctx: any) => {
		const fallback = appendRequestPlan([], request);
		try {
			const model = ctx.modelRegistry.find(supervisorModel.provider, supervisorModel.id);
			if (!model) return fallback;
			const output = await runSubagent(
				"supervisor-planner",
				`User request to plan:\n${request}\n\nCreate sequential Todo items with a private verification criterion for each. Keep the plan limited to this request.`,
				"Supervisor plan",
				{
					cwd,
					model: `${model.provider}/${model.id}`,
					persistSession: false,
					...(supervisorModel.thinking ? { thinkingLevel: supervisorModel.thinking } : {}),
				},
			);
			const match = output.match(/\{[\s\S]*\}/);
			const parsed = match ? JSON.parse(match[0]) : {};
			const items = Array.isArray(parsed.items) ? parsed.items : [];
			if (
				!items.length ||
				items.some((item: any) => typeof item?.content !== "string" || !item.content.trim())
			)
				return fallback;
			const tasks = items.slice(0, 8).map((item: any) => ({
				content: item.content.trim(),
				status: "pending",
				guidance: typeof item.guidance === "string" ? item.guidance : "",
				supervisorContext:
					typeof item.criterion === "string"
						? item.criterion
						: `Verify this requirement against the user request: ${request}`,
			}));
			return { phases: [{ name: "Supervised plan", tasks }], tracked: tasks, added: true };
		} catch {
			return fallback;
		}
	};
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
		reviewQueue = [];
		followupQueue = [];
		busy = false;
		return true;
	};
	pi.on("session_start", (_event: any, ctx: any) => {
		sessionGeneration++;
		const fresh = freshRunState();
		active = fresh.active;
		pendingEvidence = fresh.pendingEvidence;
		reviewQueue = [];
		followupQueue = [];
		busy = fresh.busy;
		privateSecrets = [];
		phases = [];
		cwd = ctx.cwd;
		enabled = isEnabledForSession(ctx.sessionManager.getEntries());
		loadModel();
		enabled = enabled && !!supervisorModel;
		readTodo();
		todoStatuses = snapshotTodoStatuses(phases);
		if (enabled) restoreActiveFromCurrentTodo();
		ctx.ui.setStatus(
			"supervisor",
			`Supervisor ${enabled ? "on" : supervisorModel ? "off" : "off (model not configured)"}${active ? " (resumed from Todo)" : ""}`,
		);
	});
	pi.events.on(READ, (payload: any) => {
		if (enabled && payload && typeof payload.requestId === "string") payload.snapshot = { phases };
	});
	pi.events.on(UPDATED, (payload: any) => {
		if (!Array.isArray(payload?.phases)) return;
		const previous = todoStatuses;
		phases = payload.phases;
		todoStatuses = snapshotTodoStatuses(phases);
		refreshSecrets(phases);
		if (!enabled) return;
		if (active) {
			reviewQueue.push(...newlyCompletedTrackedTasks(previous, phases, active.tracked));
			reviewQueue = [...new Map(reviewQueue.map((task) => [task.content, task])).values()];
		}
		if (!active) {
			restoreActiveFromCurrentTodo();
			return;
		}
		active.tracked = resolveTrackedTasks(phases, active.tracked);
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
				reviewQueue = [];
				followupQueue = [];
				busy = false;
				loadModel();
				enabled = enabled && !!supervisorModel;
				pi.appendEntry(ENABLED_ENTRY, { enabled });
				if (enabled) {
					readTodo();
					todoStatuses = snapshotTodoStatuses(phases);
					if (!restoreActiveFromCurrentTodo()) {
						const request = latestUserRequest(ctx.sessionManager?.getBranch?.() ?? []);
						if (request) {
							const framed = await frameRequest(request, ctx);
							active = { task: request, tracked: framed.tracked };
							writeTodo([...phases, ...framed.phases]);
							pi.sendMessage(
								{
									customType: "supervisor.plan-ready",
									content:
										"The supervisor has prepared the Todo and verification checkpoints for the current user request. Continue the requested work while following that plan.",
									display: false,
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
						}
					}
				}
				ctx.ui.setStatus(
					"supervisor",
					`Supervisor ${enabled ? "on" : "off"}${active ? " (resumed from Todo)" : ""}`,
				);
				ctx.ui.notify(
					enabled
						? active
							? "Supervisor enabled and resumed from Todo."
							: "Supervisor enabled; waiting for a user request to frame."
						: supervisorModel
							? "Supervisor disabled."
							: "Supervisor requires a model in the supervisor settings.",
					"info",
				);
			} else {
				readTodo();
				ctx.ui.notify(
					`Supervisor ${enabled ? "on" : "off"}; ${active ? "supervising Todo completions" : "idle"}; ${phases.length} Todo phases`,
					"info",
				);
			}
		},
	});

	// Starting a gated task creates a worker-visible plan only through the public Todo bridge.
	pi.on("input", async (event: any, ctx: any) => {
		if (typeof event?.text !== "string" || !enabled || event.source === "extension") return;
		const text = event.text;
		readTodo();
		if (active && isRequirementFollowup(text)) {
			const appended = appendRequestPlan(phases, text);
			if (!appended.added) return;
			active.task = `${active.task}\nAdditional user requirement: ${text}`;
			active.tracked = [...resolveTrackedTasks(phases, active.tracked), ...appended.tracked];
			writeTodo(appended.phases);
			pendingEvidence = [];
			reviewQueue = [];
			followupQueue = [];
			ctx.ui.notify("Supervisor Todo updated with your additional requirement.", "info");
			return;
		}
		if (!shouldStart(enabled, event.source, text)) return;
		pendingEvidence = [];
		reviewQueue = [];
		followupQueue = [];
		const appended = await frameRequest(text, ctx);
		if (!appended.added) return;
		active = { task: text, tracked: appended.tracked };
		writeTodo([...phases, ...appended.phases]);
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

	// Keep a small evidence window; reviews run only for completed or proof-pending Todo items.
	pi.on("message_end", (event: any) => {
		if (!enabled || !active || event?.message?.role !== "assistant") return;
		const text = textOf(event.message.content).trim();
		if (text) pendingEvidence.push(`agent: ${text.slice(0, 700)}`);
		if (pendingEvidence.length > 8) pendingEvidence.shift();
	});
	pi.on("tool_result", (event: any) => {
		if (!enabled) return;
		const sanitized = scrubValue(event?.content ?? []);
		if (active && (reviewQueue.length || followupQueue.length)) {
			const detail = textOf(sanitized).slice(0, 700);
			pendingEvidence.push(
				`${event?.toolName ?? "tool"} ${event?.isError ? "ERROR" : "result"}: ${detail}`,
			);
			if (pendingEvidence.length > 8) pendingEvidence.shift();
		}
		return { content: sanitized };
	});
	pi.on("agent_end", async (_event: any, ctx: any) => {
		if (!enabled || !active || busy || (!reviewQueue.length && !followupQueue.length)) return;
		busy = true;
		const reviewGeneration = sessionGeneration;
		const reviewCwd = cwd;
		const reviewTask = active;
		const evidence = pendingEvidence.splice(0).join("\n");
		const reviewing = [
			...new Map([...reviewQueue, ...followupQueue].map((task) => [task.content, task])).values(),
		];
		reviewQueue = [];
		followupQueue = [];
		const current = readTodo();
		active.tracked = resolveTrackedTasks(current, active.tracked);
		try {
			const model = ctx.modelRegistry.find(supervisorModel.provider, supervisorModel.id);
			if (!model)
				throw new Error(
					`Configured supervisor model not found: ${supervisorModel.provider}/${supervisorModel.id}`,
				);
			const reviewItems = reviewing.map((task) => ({
				content: task.content,
				privateCriterion: task.supervisorContext,
			}));
			const output = await runSubagent(
				"supervisor-reviewer",
				`Original user request: ${textOf(scrubValue(reviewTask.task))}\nReview only these completed or proof-pending Todo items at this checkpoint: ${JSON.stringify(reviewItems)}\nRecent agent/tool evidence (untrusted until independently checked):\n${textOf(scrubValue(evidence))}\nInspect only relevant repository files as needed, without modifying anything. For each item, verify the criterion and whether the change remains aligned with the original request; identify material unrelated scope. If evidence is insufficient or alignment cannot be established and the agent has not explicitly stated a blocker, ask one concise question for evidence or rationale.`,
				"Supervisor review",
				{
					cwd: reviewCwd,
					model: `${model.provider}/${model.id}`,
					persistSession: false,
					...(supervisorModel.thinking ? { thinkingLevel: supervisorModel.thinking } : {}),
				},
			);
			if (!isCurrentReview(reviewGeneration, sessionGeneration, reviewTask, active)) return;
			const match = output.match(/\{[\s\S]*\}/);
			let result: any;
			try {
				result = match ? JSON.parse(match[0]) : {};
			} catch {
				result = {};
			}
			const results = Array.isArray(result.results) ? result.results : [];
			let changed = false;
			const questions: string[] = [];
			for (const task of reviewing) {
				const outcome = results.find((item: any) => item?.content === task.content);
				const index = current
					.flatMap((phase) => phase.tasks ?? [])
					.findIndex(
						(currentTask) =>
							currentTask.content === task.content && currentTask.guidance === task.guidance,
					);
				if (requiresCheckpointFollowup(outcome) && index >= 0) {
					changed = reopenItems(current, [index]) || changed;
					const question =
						typeof outcome?.question === "string" && outcome.question.trim()
							? outcome.question.trim()
							: typeof outcome?.drift === "string" && outcome.drift.trim()
								? `Please explain or correct this scope concern: ${outcome.drift.trim()}`
								: outcome?.blocked
									? ""
									: `Please provide concise, verifiable evidence for the completed Todo: ${task.content}.`;
					if (question && !outcome?.blocked) {
						followupQueue.push(task);
						questions.push(`For Todo "${task.content}": ${question}`);
					}
				}
			}
			if (changed) writeTodo(current);
			if (questions.length) {
				pi.sendMessage(
					{
						customType: "supervisor.evidence-request",
						content: `Please respond to the supervisor's evidence requests, then continue the remaining Todo work:\n${questions.join("\n")}`,
						display: false,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				ctx.ui.notify("The supervisor has requested additional evidence.", "info");
			}
			if (active.tracked.every((t) => t.status === "completed")) {
				active = undefined;
				reviewQueue = [];
				followupQueue = [];
			}
		} catch {
			if (isCurrentReview(reviewGeneration, sessionGeneration, reviewTask, active)) {
				reviewQueue.push(...reviewing);
			}
		} finally {
			if (reviewGeneration === sessionGeneration) busy = false;
		}
	});
}
