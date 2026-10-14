import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderIndexFile, renderMemoryMap } from "../src/memory/index-render.js";
import { atomicWrite, listTopics, parseFrontMatter, readJourney, resolveWithinMemory } from "../src/memory/paths.js";
import { initSqliteMemory, sqliteDbPath, sqliteWriteFile } from "../src/memory/sqlite.js";
import { writeMemorySnapshot } from "../src/memory/snapshot.js";

let cwd: string;
let root: string; // the per-session memory root: <cwd>/.memory/<sessionId>

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-mem-"));
	root = join(cwd, ".memory", "sess-1");
	process.env.PI_OM_SQLITE_PATH = join(cwd, "test.sqlite");
});

afterEach(() => {
	delete process.env.PI_OM_SQLITE_PATH;
	rmSync(cwd, { recursive: true, force: true });
});

function writeTopic(filename: string, content: string): void {
	sqliteWriteFile(root, filename, content);
}

describe("resolveWithinMemory", () => {
	it("resolves paths inside .memory/", () => {
		expect(resolveWithinMemory(root, "auth.md")).toBe(join(root, "auth.md"));
		expect(resolveWithinMemory(root, ".memory/auth.md")).toBe(join(root, ".memory", "auth.md"));
	});

	it("rejects paths that escape the sandbox", () => {
		expect(resolveWithinMemory(root, "../secret.txt")).toBeUndefined();
		expect(resolveWithinMemory(root, "../../etc/passwd")).toBeUndefined();
	});
});

describe("parseFrontMatter", () => {
	it("parses flat key: value front-matter and returns the body", () => {
		const { front, body } = parseFrontMatter(
			"---\nid: auth\ntitle: Authentication\nsummary: JWT + sessions\nupdated: 2026-06-25 14:00\n---\nBody text here.\n",
		);
		expect(front).toEqual({ id: "auth", title: "Authentication", summary: "JWT + sessions", updated: "2026-06-25 14:00" });
		expect(body).toBe("Body text here.\n");
	});

	it("strips surrounding quotes", () => {
		const { front } = parseFrontMatter('---\nsummary: "quoted, with comma"\n---\nx');
		expect(front.summary).toBe("quoted, with comma");
	});

	it("returns empty front-matter when absent", () => {
		const { front, body } = parseFrontMatter("no front matter");
		expect(front).toEqual({});
		expect(body).toBe("no front matter");
	});
});

describe("listTopics", () => {
	it("returns parsed topics excluding INDEX.md and JOURNEY.md, sorted by filename", () => {
		writeTopic("INDEX.md", "# Memory index");
		writeTopic("JOURNEY.md", "## 2026-05-01\nStarted the project.");
		writeTopic("zebra.md", "---\nid: zebra\ntitle: Zebra\nsummary: z\n---\nbody");
		writeTopic("auth.md", "---\nid: auth\ntitle: Auth\nsummary: a\n---\nbody");
		const topics = listTopics(root);
		expect(topics.map((t) => t.filename)).toEqual(["auth.md", "zebra.md"]);
		expect(topics[0]).toMatchObject({ id: "auth", title: "Auth", summary: "a", path: ".memory/sess-1/auth.md" });
	});

	it("returns [] when the session memory root does not exist", () => {
		expect(listTopics(root)).toEqual([]);
	});
});

describe("readJourney", () => {
	it("returns undefined when JOURNEY.md is absent", () => {
		expect(readJourney(root)).toBeUndefined();
	});

	it("returns the trimmed body when present", () => {
		writeTopic("JOURNEY.md", "\n## 2026-05-01\nStarted the project.\n\n");
		expect(readJourney(root)).toBe("## 2026-05-01\nStarted the project.");
	});

	it("returns undefined when JOURNEY.md is effectively empty", () => {
		writeTopic("JOURNEY.md", "   \n\n");
		expect(readJourney(root)).toBeUndefined();
	});
});

describe("renderIndexFile / renderMemoryMap", () => {
	it("renders an empty index placeholder", () => {
		expect(renderIndexFile([])).toContain("_No topics yet._");
		expect(renderMemoryMap([])).toBeUndefined();
	});

	it("renders topics into the index file and the compaction map", () => {
		writeTopic("auth.md", "---\nid: auth\ntitle: Auth\nsummary: JWT and sessions\nupdated: 2026-06-25 14:00\n---\nbody");
		const topics = listTopics(root);
		const index = renderIndexFile(topics);
		expect(index).toContain("## Auth");
		expect(index).toContain("`.memory/sess-1/auth.md`");
		expect(index).toContain("JWT and sessions");
		const map = renderMemoryMap(topics);
		expect(map).toContain("## Memory map");
		expect(map).toContain("`.memory/sess-1/auth.md` — JWT and sessions (updated 2026-06-25 14:00)");
	});
});

describe("sqlite memory backend", () => {
	it("scopes topics and journey to the session root", () => {
		process.env.PI_OM_SQLITE_PATH = join(cwd, "test.sqlite");
		initSqliteMemory(root);
		sqliteWriteFile(root, "auth.md", "---\nid: auth\ntitle: Auth\nsummary: JWT\nupdated: 2026-06-25 14:00\n---\nbody");
		sqliteWriteFile(root, "JOURNEY.md", "journey body");

		expect(sqliteDbPath(root)).toBe(join(cwd, "test.sqlite"));
		expect(listTopics(root)[0]).toMatchObject({ path: ".memory/sess-1/auth.md", title: "Auth", summary: "JWT" });
		expect(readJourney(root)).toBe("journey body");
	});

	it("does not write a MEMORY.md mirror", () => {
		initSqliteMemory(root);
		sqliteWriteFile(root, "auth.md", "---\ntitle: Auth\nsummary: JWT\n---\nFull auth knowledge");
		writeMemorySnapshot(root);

		expect(existsSync(join(cwd, ".memory", "MEMORY.md"))).toBe(false);
		expect(listTopics(root).map((t) => t.filename)).toEqual(["auth.md"]);
	});

	it("does not import markdown files from the filesystem", () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "auth.md"), "---\ntitle: Auth\nsummary: migrated\n---\nbody");
		writeFileSync(join(root, "legacy.md"), "legacy");
		initSqliteMemory(root);

		expect(listTopics(root)).toEqual([]);
		expect(listTopics(root).some((topic) => topic.filename === "legacy.md")).toBe(false);
		expect(readJourney(root)).toBeUndefined();
	});

	it("does not create empty MEMORY.md mirrors", () => {
		process.env.PI_OM_SQLITE_PATH = join(cwd, "test.sqlite");
		initSqliteMemory(root);
		writeMemorySnapshot(root);

		expect(existsSync(join(cwd, ".memory", "MEMORY.md"))).toBe(false);
	});
});

describe("atomicWrite", () => {
	it("rejects filesystem writes", () => {
		const path = join(cwd, ".memory", "deep", "file.md");
		expect(() => atomicWrite(path, "hello")).toThrow(/disabled/);
		expect(existsSync(path)).toBe(false);
	});
});
