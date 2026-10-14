import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionMemoryRoot } from "../src/memory/paths.js";
import { ensureSessionMemory } from "../src/memory/session.js";
import { sqliteReadFile, sqliteWriteFile } from "../src/memory/sqlite.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-session-"));
	process.env.PI_OM_SQLITE_PATH = join(cwd, "memory.sqlite");
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	delete process.env.PI_OM_SQLITE_PATH;
});

/** Minimal session-file header line, as written by pi's SessionManager. */
function writeSessionFile(id: string): string {
	const file = join(cwd, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd })}\n`, "utf-8");
	return file;
}

function fakeCtx(sessionId: string, header?: { parentSession?: string }) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ id: sessionId, cwd, ...header }),
		},
	};
}

describe("ensureSessionMemory", () => {
	it("returns the per-session root and does not create it without a parent", () => {
		const root = ensureSessionMemory(fakeCtx("child"));
		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		// Lazy: nothing to seed, so the dir is left for the first durable write to create.
		expect(existsSync(root)).toBe(false);
	});

	it("clones SQLite memory from the parent session", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		sqliteWriteFile(parentRoot, "auth.md", "---\nid: auth\n---\nbody");
		sqliteWriteFile(parentRoot, "JOURNEY.md", "## history");

		const parentFile = writeSessionFile("parent");
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));

		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		expect(sqliteReadFile(root, "auth.md")).toContain("body");
		expect(sqliteReadFile(root, "JOURNEY.md")).toBe("## history");
	});

	it("is idempotent: an existing root is never re-seeded from the parent", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		sqliteWriteFile(parentRoot, "auth.md", "parent copy");
		const parentFile = writeSessionFile("parent");
		const childRoot = sessionMemoryRoot(cwd, "child");
		sqliteWriteFile(childRoot, "auth.md", "child copy");

		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(sqliteReadFile(root, "auth.md")).toBe("child copy");
	});

	it("skips seeding when the parent kept no memory under this project", () => {
		const parentFile = writeSessionFile("parent"); // no parent memory root on disk
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(existsSync(root)).toBe(false);
	});
});
