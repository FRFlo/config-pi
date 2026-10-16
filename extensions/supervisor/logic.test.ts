import { describe, expect, it } from "bun:test";
import {
	appendRequestPlan,
	cloneTodo,
	continuationPrompt,
	createPlan,
	freshRunState,
	gated,
	incompleteTasks,
	isAllowedVerificationCommand,
	isCurrentReview,
	isEnabled,
	isPathWithinCwd,
	isRequirementFollowup,
	hasVerifiableProgress,
	nextNoProgress,
	persistEnabled,
	publicTodoPrompt,
	publicWorkerSteer,
	renderPublicTodo,
	reopenItems,
	resolveTrackedTasks,
	restoreSupervisionFromTodo,
	shouldStart,
	todoChanges,
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
	it("distinguishes follow-up requirements from acknowledgments and avoids private reviewer text in steers", () => {
		expect(isRequirementFollowup("Thanks, okay.")).toBe(false);
		expect(isRequirementFollowup("Also preserve the keyboard shortcut")).toBe(true);
		const steer = publicWorkerSteer(
			[
				{
					content: "Preserve keyboard shortcuts within requested scope",
					status: "pending",
					guidance: "Keep compatibility",
				},
			],
			true,
			true,
		);
		expect(steer).toContain("Preserve keyboard shortcuts");
		expect(steer).not.toContain("supervisorContext");
		expect(steer).not.toContain("private reviewer");
	});
	it("compares baseline and current Todo for removals, replacements and agent additions", () => {
		const baseline = [
			{
				name: "Phase",
				tasks: [{ content: "Old", status: "pending", supervisorContext: "private" }],
			},
		];
		const current = [
			{
				name: "Phase",
				tasks: [{ content: "Agent-added", status: "completed", guidance: "agent result" }],
			},
		];
		const changes = todoChanges(baseline, current);
		expect(changes.removed).toHaveLength(1);
		expect(changes.added[0].content).toBe("Agent-added");
	});
	it("restricts reviewer filesystem paths to cwd and descendants", () => {
		expect(isPathWithinCwd("C:/repo", "src/file.ts")).toBe(true);
		expect(isPathWithinCwd("C:/repo", "C:/repo/src/file.ts")).toBe(true);
		expect(isPathWithinCwd("C:/repo", "../outside/secret.txt")).toBe(false);
		expect(isPathWithinCwd("C:/repo", "C:/other/secret.txt")).toBe(false);
	});
	it("restores supervision from incomplete current Todo and rebuilds a fresh baseline", () => {
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
		expect(restored.baseline).toEqual(current);
		expect(restored.baseline).not.toBe(current);
		expect(restored.task).toContain("Use the current requirement");
		expect(restored.task).not.toContain("current private audit details");
		expect(restored.todoUpdates).toEqual([]);
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
			noProgress: 0,
			stopped: false,
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
	it("rejects non-string completion evidence safely", () => {
		expect(hasVerifiableProgress(true, "test passed")).toBe(true);
		expect(hasVerifiableProgress(true, undefined)).toBe(false);
		expect(hasVerifiableProgress(true, { trim: "not callable" })).toBe(false);
	});
	it("counts current reviewer errors and ignores stale session/task errors", () => {
		const active = {};
		expect(isCurrentReview(4, 4, active, active)).toBe(true);
		expect(isCurrentReview(3, 4, active, active)).toBe(false);
		expect(isCurrentReview(4, 4, active, {})).toBe(false);
		let failures = 0;
		failures = nextNoProgress(failures, false);
		failures = nextNoProgress(failures, false);
		failures = nextNoProgress(failures, false);
		expect(failures).toBe(3);
	});
	it("stops after three cycles without verifiable progress", () => {
		let cycles = 0;
		cycles = nextNoProgress(cycles, false);
		cycles = nextNoProgress(cycles, false);
		cycles = nextNoProgress(cycles, false);
		expect(cycles).toBe(3);
		expect(nextNoProgress(cycles, true)).toBe(0);
	});
	it("persists and restores global toggle, defaulting on when absent", () => {
		let stored = "";
		expect(isEnabled(() => stored)).toBe(true);
		persistEnabled((value) => {
			stored = value;
		}, false);
		expect(isEnabled(() => stored)).toBe(false);
		persistEnabled((value) => {
			stored = value;
		}, true);
		expect(isEnabled(() => stored)).toBe(true);
	});
	it("allows only safe git inspections and standard/configured verification commands", () => {
		expect(isAllowedVerificationCommand("git diff --check")).toBe(true);
		expect(isAllowedVerificationCommand("bun run check")).toBe(true);
		expect(isAllowedVerificationCommand("bun run custom-check", ["bun run custom-check"])).toBe(
			true,
		);
		expect(isAllowedVerificationCommand("git status; rm -rf .")).toBe(false);
		expect(isAllowedVerificationCommand("node arbitrary.js")).toBe(false);
	});
});
