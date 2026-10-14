import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findAgentsFiles, registerAgentsMdCommands, updateAgentsMd } from "../src/agents-md.js";
import {
	sqliteBeginAgentsMemoryRun,
	sqliteFinishAgentsMemoryRun,
	sqliteListAgentsMemoryPages,
	sqliteMarkAgentsMemoryPageProcessed,
	sqliteReadAgentsMemoryPage,
	sqliteReadProjectMemories,
	sqliteWriteFile,
} from "../../observational-memory/src/memory/sqlite.js";
import { spawnWorker } from "../../observational-memory/src/spawn/launch.js";
import { registerAgentsMdTool } from "../worker/tool.js";
import agentsMdExtension from "../index.js";

vi.mock("../../observational-memory/src/spawn/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../observational-memory/src/spawn/launch.js")>()),
	spawnWorker: vi.fn(async () => ({ code: 0, signal: null, stderr: "" })),
}));

const roots: string[] = [];
const agentPageReads: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "om-agents-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	delete process.env.PI_OM_SQLITE_PATH;
	delete process.env.OM_PROJECT_ROOT;
	delete process.env.OM_AGENTS_TARGETS;
	vi.mocked(spawnWorker).mockClear();
	agentPageReads.length = 0;
});

beforeEach(() => {
	vi.mocked(spawnWorker).mockImplementation(async (options: any) => {
		const pageId = /Assigned memory page \d+ of \d+: ([a-f0-9]+)/.exec(options.stdin ?? "")?.[1];
		const projectRoot = /^Project root: (.+)$/m.exec(options.stdin ?? "")?.[1];
		if (pageId && projectRoot) {
			const page = sqliteReadAgentsMemoryPage(projectRoot, pageId);
			if (page) {
				agentPageReads.push(`${page.sessionId}:${page.filename}:${page.content}`);
				sqliteMarkAgentsMemoryPageProcessed(projectRoot, page.pageId, page.sourceHash, "no-useful-info", "test worker acknowledged page");
			}
		}
		return { code: 0, signal: null, stderr: "" } as any;
	});
});

it("aggregates durable memories across sessions without crossing project boundaries", () => {
	const project = tempRoot();
	process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
	sqliteWriteFile(join(project, ".memory", "session-a"), "auth.md", "shared auth rules");
	sqliteWriteFile(join(project, ".memory", "session-b"), "build.md", "build commands");
	sqliteWriteFile(join(project, "other", ".memory", "session-c"), "other.md", "other project");

	expect(sqliteReadProjectMemories(project).map((row) => `${row.sessionId}:${row.filename}`)).toEqual([
		"session-a:auth.md",
		"session-b:build.md",
	]);
});

describe("AGENTS commands", () => {
	it("provides every session's memories to both rebuild commands", async () => {
		const project = tempRoot();
		mkdirSync(join(project, "src", "app"), { recursive: true });
		mkdirSync(join(project, "src", "deep"), { recursive: true });
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		sqliteWriteFile(join(project, ".memory", "session-a"), "auth.md", "session A auth rules");
		sqliteWriteFile(join(project, ".memory", "session-b"), "build.md", "session B build rules");

		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		registerAgentsMdCommands({
			registerCommand: (name: string, options: any) => commands.set(name, options),
		} as any);
		const ctx = {
			cwd: project,
			sessionManager: { getSessionId: () => "session-a" },
			hasUI: false,
		};

		await commands.get("om:agents")!.handler("", ctx);
		await commands.get("om:agents:all")!.handler("", ctx);

		const prompts = vi.mocked(spawnWorker).mock.calls.map(([options]) => options.stdin ?? "");
		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt).toContain("Assigned memory page");
			expect(prompt.replace(/\\/g, "/")).toContain("src/app/AGENTS.md");
			expect(prompt.replace(/\\/g, "/")).toContain("src/deep/AGENTS.md");
			expect(prompt).toContain("directory contents:");
		}
		expect(prompts.slice(0, 2).every((prompt) => prompt.includes("Run mode: incremental update"))).toBe(true);
		expect(prompts.slice(2).some((prompt) => prompt.includes("full rebuild seed"))).toBe(true);
		expect(agentPageReads).toEqual(expect.arrayContaining([
			"session-a:auth.md:session A auth rules",
			"session-b:build.md:session B build rules",
		]));
		expect(sqliteListAgentsMemoryPages(project, 0, 20).pages.every((page) => page.processed)).toBe(true);
	});
});

it("allows the worker to create a recursively discovered nested target", async () => {
	const project = tempRoot();
	const nestedDir = join(project, "src", "deep");
	mkdirSync(nestedDir, { recursive: true });
	const target = join(nestedDir, "AGENTS.md");
	process.env.OM_PROJECT_ROOT = project;
	process.env.OM_AGENTS_TARGETS = JSON.stringify([target]);

	const tools = new Map<string, any>();
	registerAgentsMdTool({ registerTool: (definition: any) => tools.set(definition.name, definition) } as any);
	const tool = tools.get("write_agents_file");
	const result = await tool.execute("call", { path: "src/deep/AGENTS.md", content: "# Deep guidance\n" });

	expect(result.details.error).toBe(false);
	expect(readFileSync(target, "utf8")).toBe("# Deep guidance\n");
});

it("rejects AGENTS.md targets whose directory was replaced by a symlink", async () => {
	const project = tempRoot();
	const outside = tempRoot();
	mkdirSync(join(project, "src"), { recursive: true });
	try {
		symlinkSync(outside, join(project, "src", "deep"), process.platform === "win32" ? "junction" : "dir");
	} catch {
		return;
	}
	const target = join(project, "src", "deep", "AGENTS.md");
	process.env.OM_PROJECT_ROOT = project;
	process.env.OM_AGENTS_TARGETS = JSON.stringify([target]);

	const tools = new Map<string, any>();
	registerAgentsMdTool({ registerTool: (definition: any) => tools.set(definition.name, definition) } as any);
	const result = await tools.get("write_agents_file").execute("call", {
		path: "src/deep/AGENTS.md",
		content: "outside write",
	});
	expect(result.details.error).toBe(true);
	expect(() => readFileSync(join(outside, "AGENTS.md"), "utf8")).toThrow();
});

it("uses recursive targets for automatic consolidation updates", async () => {
	const project = tempRoot();
	const memoryRoot = join(project, ".memory", "session-a");
	mkdirSync(join(project, "src", "app"), { recursive: true });
	process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
	sqliteWriteFile(memoryRoot, "auth.md", "auth rules");
	sqliteWriteFile(join(project, ".memory", "session-b"), "build.md", "build commands");

	let onConsolidated: ((data: unknown) => void) | undefined;
	agentsMdExtension({
		registerCommand: () => undefined,
		events: {
			on: (_channel: string, handler: (data: unknown) => void) => {
				onConsolidated = handler;
				return () => undefined;
			},
		},
	} as any);
	onConsolidated?.({
		projectRoot: project,
		memoryRoot,
		model: { provider: "test", id: "model" },
	});

	await vi.waitFor(() => expect(vi.mocked(spawnWorker)).toHaveBeenCalledTimes(2));
	const prompt = vi.mocked(spawnWorker).mock.calls.at(-1)?.[0].stdin ?? "";
	expect(prompt.replace(/\\/g, "/")).toContain("src/app/AGENTS.md");
	expect(prompt).toContain("Assigned memory page");
	expect(agentPageReads).toEqual(expect.arrayContaining(["session-b:build.md:build commands"]));
});

it("omits oversized AGENTS contents and keeps those files read-only", async () => {
	const project = tempRoot();
	const memoryRoot = join(project, ".memory", "session-a");
	process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
	const largeContents = `sensitive-looking guidance ${"x".repeat(9_000)}`;
	writeFileSync(join(project, "AGENTS.md"), largeContents);
	sqliteWriteFile(memoryRoot, "topic.md", "durable memory");

	await updateAgentsMd(
		{ memoryRoot, model: { provider: "test", id: "model" } as any },
		project,
		{ rebuild: false },
	);
	const options = vi.mocked(spawnWorker).mock.calls.at(-1)?.[0];
	expect(options?.stdin).toContain("read-only for this page");
	expect(options?.stdin).not.toContain(largeContents);
	expect(JSON.parse(options?.env?.OM_AGENTS_TARGETS ?? "[]")).not.toContain(join(project, "AGENTS.md"));
});

describe("paginated memory processing", () => {
	it("handles an empty SQLite database without assuming memory tables exist", () => {
		const project = tempRoot();
		process.env.PI_OM_SQLITE_PATH = join(project, "empty.sqlite");
		const run = sqliteBeginAgentsMemoryRun(project, "full");
		expect(run.pages).toEqual([]);
		expect(sqliteListAgentsMemoryPages(project).pages).toEqual([]);
		expect(sqliteFinishAgentsMemoryRun(project, run.revision)).toBe(true);
		const db = new DatabaseSync(join(project, "empty.sqlite"), { readOnly: true });
		try {
			const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name);
			expect(tables).not.toContain("topics");
			expect(tables).not.toContain("journey");
			expect(tables).not.toContain("agents_md_memory_pages");
			expect(tables).not.toContain("agents_md_memory_runs");
		} finally {
			db.close();
		}
	});

	it("reports a memory revision conflict instead of claiming success", async () => {
		const project = tempRoot();
		const memoryRoot = join(project, ".memory", "session-a");
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		sqliteWriteFile(memoryRoot, "first.md", "initial memory");
		vi.mocked(spawnWorker).mockImplementationOnce(async (options: any) => {
			const pageId = /Assigned memory page \d+ of \d+: ([a-f0-9]+)/.exec(options.stdin ?? "")?.[1];
			const page = pageId ? sqliteReadAgentsMemoryPage(project, pageId) : undefined;
			expect(page).toBeDefined();
			sqliteMarkAgentsMemoryPageProcessed(project, page!.pageId, page!.sourceHash, "no-useful-info", "test");
			sqliteWriteFile(join(project, ".memory", "session-b"), "second.md", "added during run");
			return { code: 0, signal: null, stderr: "" } as any;
		});

		await expect(updateAgentsMd(
			{ memoryRoot, model: { provider: "test", id: "model" } as any },
			project,
			{ rebuild: false },
		)).rejects.toThrow(/memory inventory changed during processing/);
	});

	it("splits supplementary characters without losing or duplicating code units", () => {
		const project = tempRoot();
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		const source = `${"x".repeat(11_999)}😀tail`;
		sqliteWriteFile(join(project, ".memory", "session-a"), "unicode.md", source);

		const pages = sqliteBeginAgentsMemoryRun(project, "incremental").pages;
		expect(pages).toHaveLength(2);
		expect(pages.map((page) => sqliteReadAgentsMemoryPage(project, page.pageId)?.content).join("")).toBe(source);
	});

	it("migrates legacy page tracking into source-row progress and removes tracking tables", () => {
		const project = tempRoot();
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		sqliteWriteFile(join(project, ".memory", "session-a"), "legacy.md", "legacy memory");
		const page = sqliteBeginAgentsMemoryRun(project, "incremental").pages[0];
		const db = new DatabaseSync(join(project, "memories.sqlite"));
		try {
			db.exec(`CREATE TABLE agents_md_memory_pages (
				project_root TEXT, page_id TEXT, source_hash TEXT, session_id TEXT, filename TEXT,
				part_index INTEGER, total_parts INTEGER, processed_at INTEGER, outcome TEXT, notes TEXT,
				read_count INTEGER, processed_read_count INTEGER
			);
			CREATE TABLE agents_md_memory_runs (
				project_root TEXT, revision TEXT, mode TEXT, status TEXT, updated_at INTEGER
			);`);
			db.prepare(`INSERT INTO agents_md_memory_pages
				(project_root, page_id, source_hash, session_id, filename, part_index, total_parts, processed_at, outcome, notes)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				project, page.pageId, page.sourceHash, page.sessionId, page.filename, page.partIndex,
				page.totalParts, Date.now(), "no-useful-info", "legacy acknowledgement",
			);
		} finally {
			db.close();
		}

		expect(sqliteListAgentsMemoryPages(project).pages[0]).toMatchObject({
			processed: true,
			outcome: "no-useful-info",
			notes: "legacy acknowledgement",
		});
		const migratedDb = new DatabaseSync(join(project, "memories.sqlite"), { readOnly: true });
		try {
			const tables = (migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name);
			expect(tables).not.toContain("agents_md_memory_pages");
			expect(tables).not.toContain("agents_md_memory_runs");
		} finally {
			migratedDb.close();
		}
	});

	it("keeps an unrecognized legacy progress table intact instead of dropping it", () => {
		const project = tempRoot();
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		sqliteWriteFile(join(project, ".memory", "session-a"), "memory.md", "existing memory");
		const db = new DatabaseSync(join(project, "memories.sqlite"));
		try {
			db.exec("CREATE TABLE agents_md_memory_pages (sentinel TEXT); INSERT INTO agents_md_memory_pages VALUES ('preserve-me');");
		} finally {
			db.close();
		}

		sqliteListAgentsMemoryPages(project);
		const migratedDb = new DatabaseSync(join(project, "memories.sqlite"), { readOnly: true });
		try {
			expect(migratedDb.prepare("SELECT sentinel FROM agents_md_memory_pages").get()).toEqual({ sentinel: "preserve-me" });
		} finally {
			migratedDb.close();
		}
	});

	it("splits long memories into pages and persists acknowledgement until the source changes", () => {
		const project = tempRoot();
		process.env.PI_OM_SQLITE_PATH = join(project, "memories.sqlite");
		sqliteWriteFile(join(project, ".memory", "session-a"), "large.md", "x".repeat(25_000));

		const run = sqliteBeginAgentsMemoryRun(project, "incremental");
		expect(run.pages).toHaveLength(3);
		const page = run.pages[0];
		expect(sqliteMarkAgentsMemoryPageProcessed(project, page.pageId, page.sourceHash, "no-useful-info", "No reusable rule")).toBe(false);
		expect(sqliteReadAgentsMemoryPage(project, page.pageId)?.content).toHaveLength(12_000);
		expect(sqliteMarkAgentsMemoryPageProcessed(project, page.pageId, page.sourceHash, "no-useful-info", "No reusable rule")).toBe(true);
		expect(sqliteListAgentsMemoryPages(project, 0, 1).pages[0]).toMatchObject({
			pageId: page.pageId,
			processed: true,
			outcome: "no-useful-info",
			notes: "No reusable rule",
		});
		const db = new DatabaseSync(join(project, "memories.sqlite"), { readOnly: true });
		try {
			const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name);
			const topicColumns = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map(({ name }) => name);
			const journeyColumns = (db.prepare("PRAGMA table_info(journey)").all() as Array<{ name: string }>).map(({ name }) => name);
			expect(tables).not.toContain("agents_md_memory_pages");
			expect(tables).not.toContain("agents_md_memory_runs");
			expect(topicColumns).toContain("agents_md_progress");
			expect(journeyColumns).toContain("agents_md_progress");
		} finally {
			db.close();
		}

		sqliteReadAgentsMemoryPage(project, page.pageId);
		expect(sqliteMarkAgentsMemoryPageProcessed(project, page.pageId, page.sourceHash, "revisited-no-change", "Rechecked")).toBe(true);
		sqliteWriteFile(join(project, ".memory", "session-a"), "large.md", "updated source");
		const updated = sqliteBeginAgentsMemoryRun(project, "incremental");
		expect(updated.pages[0].pageId).toBe(page.pageId);
		expect(updated.pages[0].sourceHash).not.toBe(page.sourceHash);
		expect(updated.pages[0].processed).toBe(false);
		const updatedDb = new DatabaseSync(join(project, "memories.sqlite"), { readOnly: true });
		try {
			expect(updatedDb.prepare("SELECT agents_md_progress FROM topics WHERE filename='large.md'").get()).toEqual({ agents_md_progress: null });
		} finally {
			updatedDb.close();
		}
	});
});

describe("findAgentsFiles", () => {
	it("offers every non-ignored directory as a candidate and preserves existing instructions", () => {
		const root = tempRoot();
		mkdirSync(join(root, "src", "deep"), { recursive: true });
		mkdirSync(join(root, "src", "app"), { recursive: true });
		mkdirSync(join(root, "src", "ordinary"), { recursive: true });
		mkdirSync(join(root, "src", "module"), { recursive: true });
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(root, "src", "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(root, "src", "module", "package.json"), "{}");
		writeFileSync(join(root, "src", "AGENTS.md"), "src");
		writeFileSync(join(root, "src", "deep", "AGENTS.md"), "existing deep guidance");
		writeFileSync(join(root, "node_modules", "pkg", "AGENTS.md"), "ignored");
		writeFileSync(join(root, "src", "node_modules", "pkg", "AGENTS.md"), "ignored nested");

		expect(findAgentsFiles(root)).toEqual([
			join(root, "AGENTS.md"),
			join(root, "src", "AGENTS.md"),
			join(root, "src", "app", "AGENTS.md"),
			join(root, "src", "deep", "AGENTS.md"),
			join(root, "src", "module", "AGENTS.md"),
			join(root, "src", "ordinary", "AGENTS.md"),
		]);
	});

	it("honors root and nested .gitignore rules, including negated patterns", () => {
		const root = tempRoot();
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, "src", "hidden", "blocked", "private"), { recursive: true });
		mkdirSync(join(root, "src", "hidden", "blocked", "keep"), { recursive: true });
		mkdirSync(join(root, "ignored-root", "nested"), { recursive: true });
		writeFileSync(join(root, ".gitignore"), "ignored-root/\n");
		writeFileSync(join(root, "src", ".gitignore"), "hidden/blocked/*\n!hidden/blocked/keep/\n");
		writeFileSync(join(root, "ignored-root", "nested", "AGENTS.md"), "ignored");
		writeFileSync(join(root, "src", "hidden", "blocked", "private", "AGENTS.md"), "ignored");

		expect(findAgentsFiles(root)).toEqual([
			join(root, "AGENTS.md"),
			join(root, "src", "AGENTS.md"),
			join(root, "src", "hidden", "AGENTS.md"),
			join(root, "src", "hidden", "blocked", "keep", "AGENTS.md"),
		]);
	});

	it("does not discover root or nested AGENTS.md files ignored by Git", () => {
		const root = tempRoot();
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, "src", "ordinary"), { recursive: true });
		writeFileSync(join(root, ".gitignore"), "/AGENTS.md\n/src/AGENTS.md\n");
		writeFileSync(join(root, "AGENTS.md"), "ignored root");
		writeFileSync(join(root, "src", "AGENTS.md"), "ignored nested");

		expect(findAgentsFiles(root)).toEqual([join(root, "src", "ordinary", "AGENTS.md")]);
	});
});
