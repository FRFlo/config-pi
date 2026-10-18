import { describe, expect, it } from "bun:test";
import {
	appendRequestPlan,
	cloneTodo,
	continuationPrompt,
	createPlan,
	freshRunState,
	gated,
	incompleteTasks,
	isEnabledForSession,
	isCurrentReview,
	isPathWithinCwd,
	isRequirementFollowup,
	isSupervisorCommand,
	latestUserRequest,
	loadSupervisorModel,
	newlyCompletedTrackedTasks,
	snapshotTodoStatuses,
	publicTodoPrompt,
	renderPublicTodo,
	requiresCheckpointFollowup,
	reopenItems,
	resolveTrackedTasks,
	restoreSupervisionFromTodo,
	shouldStart,
} from "./logic.ts";

describe("supervisor policy", () => {
	it("gates multi-step work but ignores simple questions and extension steers", () => {
		expect(gated("What does this error mean?")).toBe(false);
		expect(gated("Create a small helper function")).toBe(false);
		expect(gated("Fix the button color")).toBe(false);
		expect(gated("Implement the parser")).toBe(false);
		expect(gated("Implement the parser and add focused tests")).toBe(true);
		expect(gated("Migrate production credentials safely")).toBe(true);
		expect(shouldStart(true, "interactive", "Implement the parser and add tests")).toBe(true);
		expect(shouldStart(true, "extension", "Implement the parser and add tests")).toBe(false);
		expect(shouldStart(false, "interactive", "Implement the parser and add tests")).toBe(false);
	});
	it("creates request-specific planned items with private reviewer-only audit context", () => {
		const plan = createPlan("Implement parser changes; preserve comments; add parser tests.");
		const titles = plan.flatMap((p) => p.tasks).map((t) => t.content);
		expect(titles.some((t) => /parser changes/i.test(t))).toBe(true);
		expect(titles.some((t) => /preserve comments/i.test(t))).toBe(true);
		expect(titles.some((t) => /parser tests/i.test(t))).toBe(true);
		expect(
			plan
				.flatMap((p) => p.tasks)
				.every((t) => typeof t.supervisorContext === "string" && t.supervisorContext.length > 0),
		).toBe(true);
		for (const title of titles) expect(title.trim().split(/\s+/).length).toBeGreaterThanOrEqual(5);
		for (const title of titles) expect(title.trim().split(/\s+/).length).toBeLessThanOrEqual(10);
		expect(plan[0].tasks[0].guidance).toContain("Implement parser changes");
	});
	it("builds public worker Todo content without exposing private context", () => {
		const phases = [
			{
				name: "Plan",
				tasks: [
					{
						content: "Check parser",
						status: "in_progress",
						guidance: "Keep it small",
						supervisorContext: "credential=secret",
					},
				],
			},
		];
		const prompt = JSON.stringify(renderPublicTodo(phases));
		expect(prompt).toContain("Check parser");
		expect(prompt).toContain("Keep it small");
		expect(prompt).toContain("in_progress");
		expect(prompt).not.toContain("credential=secret");
		expect(prompt).not.toContain("supervisorContext");
		const workerPrompt = publicTodoPrompt(phases, "base prompt");
		expect(workerPrompt).toContain("Plan");
		expect(workerPrompt).toContain("tasks");
		expect(workerPrompt).toContain("Check parser");
		expect(workerPrompt).toContain("Keep it small");
		expect(workerPrompt).toContain("in_progress");
		expect(workerPrompt).not.toContain("credential=secret");
		const active = incompleteTasks(phases)
			.map((t) => t.content + t.guidance)
			.join(" ");
		expect(active).not.toContain("credential=secret");
	});
	it("reopens unsupported completion and returns exact outstanding public tasks", () => {
		const phases = [
			{
				name: "Plan",
				tasks: [
					{
						content: "Verify output",
						status: "completed",
						guidance: "Run focused tests",
						supervisorContext: "private",
					},
				],
			},
		];
		expect(reopenItems(phases, [0])).toBe(true);
		expect(incompleteTasks(phases)).toEqual([
			{ content: "Verify output", guidance: "Run focused tests", status: "pending" },
		]);
		expect(continuationPrompt(incompleteTasks(phases))).toContain(
			"[pending] Verify output — Guidance: Run focused tests",
		);
	});
	it("uses flattened indexes to reopen an item in a later phase", () => {
		const phases = [
			{
				name: "First",
				tasks: [
					{ content: "One", status: "completed" },
					{ content: "Two", status: "completed" },
				],
			},
			{
				name: "Second",
				tasks: [
					{ content: "Three", status: "completed" },
					{ content: "Four", status: "completed" },
				],
			},
		];
		expect(reopenItems(phases, [3])).toBe(true);
		expect(phases[0].tasks.map((t) => t.status)).toEqual(["completed", "completed"]);
		expect(phases[1].tasks.map((t) => t.status)).toEqual(["completed", "pending"]);
	});
	it("preserves existing Todo entries and appends only non-duplicate request items", () => {
		const original = [
			{
				name: "Existing",
				tasks: [
					{
						content: "Old task",
						status: "in_progress",
						guidance: "old guidance",
						supervisorContext: "old private",
					},
				],
			},
		];
		const appended = appendRequestPlan(
			original,
			"Also ensure the cache is invalidated after updates",
		);
		expect(appended.added).toBe(true);
		expect(appended.phases[0].name).toBe("Existing");
		expect(appended.phases[0].tasks[0]).toEqual(original[0].tasks[0]);
		expect(appended.phases[0].tasks.length).toBeGreaterThan(1);
		expect(
			appended.tracked.every(
				(t) => t.content.split(/\s+/).length >= 5 && t.content.split(/\s+/).length <= 10,
			),
		).toBe(true);
		const duplicate = appendRequestPlan(
			appended.phases,
			"Also ensure the cache is invalidated after updates",
		);
		expect(duplicate.added).toBe(false);
		const allDone = cloneTodo([
			{ name: "Done", tasks: [{ content: "Finished", status: "completed" }] },
		]);
		const fresh = appendRequestPlan(allDone, "Also preserve the cache invalidation behavior");
		expect(fresh.phases).toHaveLength(2);
		expect(fresh.phases[0].tasks[0].content).toBe("Finished");
	});
	it("distinguishes follow-up requirements from acknowledgments", () => {
		expect(isRequirementFollowup("Thanks, okay.")).toBe(false);
		expect(isRequirementFollowup("Also preserve the keyboard shortcut")).toBe(true);
	});
	it("uses the latest actual user request and skips supervisor commands", () => {
		expect(
			latestUserRequest([
				{
					type: "message",
					message: { role: "user", content: "Implement the parser and add tests" },
				},
				{ type: "message", message: { role: "assistant", content: "Starting now." } },
				{ type: "message", message: { role: "user", content: "/supervisor on" } },
			]),
		).toBe("Implement the parser and add tests");
		expect(isSupervisorCommand(" /supervisor on ")).toBe(true);
		expect(isSupervisorCommand("Please enable supervisor")).toBe(false);
		expect(latestUserRequest([{ role: "user", content: "/supervisor on" }])).toBeUndefined();
	});
	it("queues only newly completed tracked Todo items", () => {
		const previous = [
			{
				name: "Phase",
				tasks: [
					{ content: "Done before", status: "completed" },
					{ content: "Target", status: "in_progress" },
					{ content: "Untracked", status: "in_progress" },
				],
			},
		];
		const next = [
			{
				name: "Phase",
				tasks: [
					{ content: "Done before", status: "completed" },
					{ content: "Target", status: "completed" },
					{ content: "Untracked", status: "completed" },
				],
			},
		];
		expect(newlyCompletedTrackedTasks(previous, next, [{ content: "Target" }])).toEqual([
			next[0].tasks[1],
		]);
		expect(newlyCompletedTrackedTasks(next, next, [{ content: "Target" }])).toEqual([]);
		const snapshot = snapshotTodoStatuses(previous);
		previous[0].tasks[1].status = "completed";
		expect(newlyCompletedTrackedTasks(snapshot, next, [{ content: "Target" }])).toEqual([
			next[0].tasks[1],
		]);
	});
	it("requires checkpoint follow-up for missing evidence or scope drift", () => {
		expect(requiresCheckpointFollowup({ verified: true, scopeAligned: true })).toBe(false);
		expect(requiresCheckpointFollowup({ verified: false, scopeAligned: true })).toBe(true);
		expect(requiresCheckpointFollowup({ verified: true, scopeAligned: false })).toBe(true);
		expect(requiresCheckpointFollowup(undefined)).toBe(true);
	});
	it("loads and overlays a configured reviewer model", () => {
		expect(
			loadSupervisorModel([
				{ supervisor: { model: { id: "project-reviewer", thinking: "low" } } },
				{ supervisor: { model: { provider: "global", id: "global-reviewer" } } },
			]),
		).toEqual({ provider: "global", id: "project-reviewer", thinking: "low" });
		expect(
			loadSupervisorModel([{ observationalMemory: { model: { provider: "x", id: "y" } } }]),
		).toBeUndefined();
		expect(loadSupervisorModel([{ supervisor: { model: { provider: "x" } } }])).toBeUndefined();
	});
	it("restricts reviewer filesystem paths to cwd and descendants", () => {
		expect(isPathWithinCwd("C:/repo", "src/file.ts")).toBe(true);
		expect(isPathWithinCwd("C:/repo", "C:/repo/src/file.ts")).toBe(true);
		expect(isPathWithinCwd("C:/repo", "../outside/secret.txt")).toBe(false);
		expect(isPathWithinCwd("C:/repo", "C:/other/secret.txt")).toBe(false);
	});
	it("restores supervision from incomplete current Todo", () => {
		const current = [
			{
				name: "Current branch",
				tasks: [
					{
						content: "Resume a supervised implementation",
						status: "in_progress",
						guidance: "Use the current requirement",
						supervisorContext: "current private audit details",
					},
					{ content: "Already complete", status: "completed" },
				],
			},
		];
		const restored = restoreSupervisionFromTodo(current, true)!;
		expect(restored.tracked).toHaveLength(2);
		expect(restored.tracked[0]).toBe(current[0].tasks[0]);
		expect(restored.tracked[1]).toBe(current[0].tasks[1]);
		expect(restored.tracked[1].status).toBe("completed");
		expect(restored.task).toContain("Use the current requirement");
		expect(restored.task).not.toContain("current private audit details");
		expect(restoreSupervisionFromTodo(current, false)).toBeUndefined();
	});
	it("does not restore supervision when the current Todo has no incomplete tasks", () => {
		expect(restoreSupervisionFromTodo([], true)).toBeUndefined();
		expect(
			restoreSupervisionFromTodo(
				[{ name: "Done", tasks: [{ content: "Finished", status: "completed" }] }],
				true,
			),
		).toBeUndefined();
	});
	it("resets all run-local supervision state on session lifecycle changes", () => {
		expect(freshRunState()).toEqual({
			active: undefined,
			pendingEvidence: [],
			busy: false,
		});
	});
	it("resolves a tracked Todo task when guidance changed but content is unique", () => {
		const updated = {
			content: "Unique task title",
			status: "in_progress",
			guidance: "edited guidance",
		};
		const resolved = resolveTrackedTasks(
			[{ name: "Phase", tasks: [updated] }],
			[{ content: "Unique task title", status: "pending", guidance: "old guidance" }],
		);
		expect(resolved[0]).toBe(updated);
	});
	it("ignores stale review results", () => {
		const active = {};
		expect(isCurrentReview(4, 4, active, active)).toBe(true);
		expect(isCurrentReview(3, 4, active, active)).toBe(false);
		expect(isCurrentReview(4, 4, active, {})).toBe(false);
	});
	it("restores the latest session toggle and defaults disabled", () => {
		expect(isEnabledForSession([])).toBe(false);
		expect(
			isEnabledForSession([
				{ type: "custom", customType: "supervisor.enabled", data: { enabled: true } },
				{ type: "custom", customType: "other.extension", data: { enabled: false } },
			]),
		).toBe(true);
		expect(
			isEnabledForSession([
				{ type: "custom", customType: "supervisor.enabled", data: { enabled: true } },
				{ type: "custom", customType: "supervisor.enabled", data: { enabled: false } },
			]),
		).toBe(false);
		expect(
			isEnabledForSession([
				{ type: "custom", customType: "supervisor.enabled", data: { enabled: "true" } },
			]),
		).toBe(false);
	});
});
