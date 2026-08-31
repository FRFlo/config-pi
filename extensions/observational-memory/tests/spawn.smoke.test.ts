import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_EXTENSION_PATH, buildWorkerArgv, buildWorkerEnv, modelArg } from "../src/spawn/launch.js";
import { readObserverResult, readWorkerCost, runCostPath, runResultPath, runsDir, writeObserverResult, writeWorkerCost } from "../src/spawn/runs.js";
import { sqliteDbPath } from "../src/memory/sqlite.js";
import { registerObserverTool } from "../agent/observer/tool.js";

describe("launch argv + env", () => {
	const model = { provider: "anthropic" as const, id: "claude-sonnet-4-6", thinking: "low" as const };

	it("builds the headless yt-edit-style flag set", () => {
		const argv = buildWorkerArgv({ model, sessionName: "om-observer-x", kickoffPrompt: "go" });
		expect(argv).not.toContain("--no-extensions");
		expect(argv).toContain("--no-builtin-tools");
		expect(argv).toContain("--no-skills");
		expect(argv).toContain("--no-prompt-templates");
		expect(argv).toContain("--no-context-files");
		expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
		expect(argv[argv.indexOf("--thinking") + 1]).toBe("low");
		expect(argv[argv.indexOf("-e") + 1]).toBe(AGENT_EXTENSION_PATH);
		expect(argv[argv.indexOf("-n") + 1]).toBe("om-observer-x");
		expect(argv).toContain("-p");
		expect(argv).not.toContain("go");
		expect(AGENT_EXTENSION_PATH.replace(/\\/g, "/").endsWith("/agent/index.ts")).toBe(true);
	});

	it("omits --thinking when no level is configured", () => {
		const argv = buildWorkerArgv({ model: { provider: "x", id: "y" }, sessionName: "n", kickoffPrompt: "p" });
		expect(argv).not.toContain("--thinking");
	});

	it("formats the model arg as provider/id", () => {
		expect(modelArg(model)).toBe("anthropic/claude-sonnet-4-6");
	});

	it("sets the worker IPC env vars", () => {
		const memoryRoot = "/proj/.memory/sess-1";
		const env = buildWorkerEnv("observer", { memoryRoot, runId: "r1" });
		expect(env.OM_WORKER).toBe("observer");
		expect(env.OM_RUN_ID).toBe("r1");
		// Chunk travels as the `pi -p` prompt (recorded user message), not via env/file.
		expect(env.OM_CHUNK_PATH).toBeUndefined();
		expect(env.OM_RESULT_PATH).toBe(runResultPath(memoryRoot, "r1"));
		expect(env.OM_MEMORY_DIR).toBe(memoryRoot);
	});

	it("resolves run paths under the session memory root's .runs", () => {
		expect(runsDir("/proj/.memory/sess-1").replace(/\\/g, "/")).toBe("/proj/.memory/sess-1/.runs");
	});
});

describe("observer result IPC round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-runs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes and reads back valid observations, dropping malformed ones", () => {
		const path = join(dir, "r.result.json");
		writeObserverResult(path, {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "ok" },
				{ timestamp: "2026-06-25 14:31", content: "  " }, // dropped: blank content
			],
		});
		const result = readObserverResult(path);
		expect(result.observations).toEqual([{ timestamp: "2026-06-25 14:30", content: "ok" }]);
	});

	it("throws on a result file missing the observations array", () => {
		const path = join(dir, "bad.result.json");
		writeFileSync(path, JSON.stringify({ nope: true }));
		expect(() => readObserverResult(path)).toThrow();
	});

	it("stores worker result and cost in sqlite when requested", () => {
		const prev = { ...process.env };
		process.env.OM_MEMORY_BACKEND = "sqlite";
		process.env.OM_MEMORY_DIR = dir;
		process.env.OM_RUN_ID = "r-sqlite";
		process.env.OM_WORKER = "observer";
		process.env.PI_OM_SQLITE_PATH = join(dir, "test.sqlite");
		try {
			writeObserverResult(runResultPath(dir, "r-sqlite"), { observations: [{ timestamp: "2026-06-25 14:30", content: "ok" }] });
			writeWorkerCost(runCostPath(dir, "r-sqlite"), { costUsd: 0.12 });
			delete process.env.OM_MEMORY_BACKEND;
			delete process.env.OM_RUN_ID;
			delete process.env.OM_WORKER;
			expect(readObserverResult(runResultPath(dir, "r-sqlite")).observations).toEqual([
				{ timestamp: "2026-06-25 14:30", content: "ok" },
			]);
			expect(readWorkerCost(runCostPath(dir, "r-sqlite"))).toEqual({ costUsd: 0.12 });
			expect(sqliteDbPath(dir)).toBe(join(dir, "test.sqlite"));
		} finally {
			process.env = prev;
		}
	});
});

describe("registerObserverTool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-tool-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes an empty result file on registration and accumulates across calls", async () => {
		const path = join(dir, "r.result.json");
		let tool: any;
		const fakePi = { registerTool: (def: any) => (tool = def) } as any;

		registerObserverTool(fakePi, path);
		expect(readObserverResult(path).observations).toEqual([]);

		await tool.execute("id1", { observations: [{ timestamp: "2026-06-25 14:30", content: "first" }] });
		await tool.execute("id2", {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "first" }, // duplicate
				{ timestamp: "2026-06-25 14:31", content: "second" },
			],
		});

		expect(readObserverResult(path).observations).toEqual([
			{ timestamp: "2026-06-25 14:30", content: "first" },
			{ timestamp: "2026-06-25 14:31", content: "second" },
		]);
	});
});
