import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Topic, TopicFrontMatter } from "./paths.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;
const require = createRequire(import.meta.url);

type Row = Record<string, unknown>;

export type MemoryScope = {
	projectRoot: string;
	sessionId: string;
};

export function sqliteDbPath(root: string): string {
	void root;
	return process.env.PI_OM_SQLITE_PATH || join(getAgentDir(), "observational-memory.sqlite");
}

export function scopeFromRoot(root: string): MemoryScope {
	const abs = resolve(root);
	return { projectRoot: resolve(abs, "..", ".."), sessionId: basename(abs) };
}

function portable(path: string): string {
	return path.replace(/\\/g, "/");
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseTopicFrontMatter(content: string): TopicFrontMatter {
	const match = FRONT_MATTER_RE.exec(content);
	if (!match) return {};
	const front: TopicFrontMatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key === "id" || key === "title" || key === "summary" || key === "updated") front[key] = value;
	}
	return front;
}

function open(root: string): { db: DatabaseSync; scope: MemoryScope } {
	const dbPath = sqliteDbPath(root);
	mkdirSync(dirname(dbPath), { recursive: true });
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS memory_scope (
			project_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (project_root, session_id)
		);
		CREATE TABLE IF NOT EXISTS topics (
			project_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			filename TEXT NOT NULL,
			id TEXT,
			title TEXT,
			summary TEXT,
			updated TEXT,
			content TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (project_root, session_id, filename),
			FOREIGN KEY (project_root, session_id) REFERENCES memory_scope(project_root, session_id)
		);
		CREATE TABLE IF NOT EXISTS journey (
			project_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			body TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (project_root, session_id),
			FOREIGN KEY (project_root, session_id) REFERENCES memory_scope(project_root, session_id)
		);
		CREATE TABLE IF NOT EXISTS worker_runs (
			project_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			role TEXT NOT NULL,
			result_json TEXT,
			cost_usd REAL,
			created_at INTEGER NOT NULL,
			finished_at INTEGER,
			PRIMARY KEY (project_root, session_id, run_id),
			FOREIGN KEY (project_root, session_id) REFERENCES memory_scope(project_root, session_id)
		);
	`);
	const scope = scopeFromRoot(root);
	db.prepare("INSERT OR IGNORE INTO memory_scope(project_root, session_id, created_at) VALUES (?, ?, ?)").run(
		scope.projectRoot,
		scope.sessionId,
		Date.now(),
	);
	migrateFilesIfPresent(root, db, scope);
	return { db, scope };
}

function openRaw(root: string): { db: DatabaseSync; scope: MemoryScope } {
	const dbPath = sqliteDbPath(root);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return { db: new DatabaseSync(dbPath), scope: scopeFromRoot(root) };
}

function migrateFilesIfPresent(root: string, db: DatabaseSync, scope: MemoryScope): void {
	if (!existsSync(root)) return;
	const topicCount = db.prepare("SELECT COUNT(*) AS n FROM topics WHERE project_root=? AND session_id=?").get(
		scope.projectRoot,
		scope.sessionId,
	) as { n: number };
	if (topicCount.n === 0) {
		for (const filename of readdirSync(root)) {
			if (!filename.endsWith(".md") || filename === "INDEX.md" || filename === "JOURNEY.md") continue;
			const content = readFileSync(join(root, filename), "utf-8");
			const front = parseTopicFrontMatter(content);
			db.prepare(`INSERT OR IGNORE INTO topics(project_root, session_id, filename, id, title, summary, updated, content, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				scope.projectRoot,
				scope.sessionId,
				filename,
				front.id ?? null,
				front.title ?? null,
				front.summary ?? null,
				front.updated ?? null,
				content,
				Date.now(),
			);
		}
	}
	const journey = db.prepare("SELECT 1 FROM journey WHERE project_root=? AND session_id=?").get(
		scope.projectRoot,
		scope.sessionId,
	);
	const journeyFile = join(root, "JOURNEY.md");
	if (!journey && existsSync(journeyFile)) {
		const body = readFileSync(journeyFile, "utf-8").trim();
		if (body) {
			db.prepare("INSERT INTO journey(project_root, session_id, body, updated_at) VALUES (?, ?, ?, ?)").run(
				scope.projectRoot,
				scope.sessionId,
				body,
				Date.now(),
			);
		}
	}
}

function close<T>(root: string, fn: (db: DatabaseSync, scope: MemoryScope) => T): T {
	const { db, scope } = open(root);
	try {
		return fn(db, scope);
	} finally {
		db.close();
	}
}

export function sqliteExists(root: string): boolean {
	return existsSync(sqliteDbPath(root));
}

export function sqliteHasScope(root: string): boolean {
	if (!sqliteExists(root)) return false;
	const { db, scope: s } = openRaw(root);
	try {
		const row = db.prepare("SELECT 1 AS ok FROM memory_scope WHERE project_root=? AND session_id=?").get(
			s.projectRoot,
			s.sessionId,
		) as Row | undefined;
		return row !== undefined;
	} catch {
		return false;
	} finally {
		db.close();
	}
}

export function initSqliteMemory(root: string): void {
	close(root, () => undefined);
}

export function writeSqliteRunResult(root: string, runId: string, role: string, result: unknown): void {
	close(root, (db, s) => {
		db.prepare(`INSERT INTO worker_runs(project_root, session_id, run_id, role, result_json, created_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(project_root, session_id, run_id) DO UPDATE SET result_json=excluded.result_json, finished_at=excluded.finished_at`).run(
			s.projectRoot,
			s.sessionId,
			runId,
			role,
			JSON.stringify(result),
			Date.now(),
			Date.now(),
		);
	});
}

export function readSqliteRunResult(root: string, runId: string): unknown | undefined {
	return close(root, (db, s) => {
		const row = db.prepare("SELECT result_json FROM worker_runs WHERE project_root=? AND session_id=? AND run_id=?").get(
			s.projectRoot,
			s.sessionId,
			runId,
		) as Row | undefined;
		return typeof row?.result_json === "string" ? JSON.parse(row.result_json) : undefined;
	});
}

export function writeSqliteRunCost(root: string, runId: string, role: string, costUsd: number): void {
	close(root, (db, s) => {
		db.prepare(`INSERT INTO worker_runs(project_root, session_id, run_id, role, cost_usd, created_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(project_root, session_id, run_id) DO UPDATE SET cost_usd=excluded.cost_usd, finished_at=excluded.finished_at`).run(
			s.projectRoot,
			s.sessionId,
			runId,
			role,
			costUsd,
			Date.now(),
			Date.now(),
		);
	});
}

export function readSqliteRunCost(root: string, runId: string): number | undefined {
	return close(root, (db, s) => {
		const row = db.prepare("SELECT cost_usd FROM worker_runs WHERE project_root=? AND session_id=? AND run_id=?").get(
			s.projectRoot,
		s.sessionId,
			runId,
		) as Row | undefined;
		return typeof row?.cost_usd === "number" ? row.cost_usd : undefined;
	});
}

export function sqliteReadFile(root: string, path: string): string | undefined {
	const filename = basename(path);
	if (filename === "JOURNEY.md") return sqliteReadJourney(root);
	return close(root, (db, s) => {
		const row = db.prepare("SELECT content FROM topics WHERE project_root=? AND session_id=? AND filename=?").get(
			s.projectRoot,
			s.sessionId,
			filename,
		) as Row | undefined;
		return typeof row?.content === "string" ? row.content : undefined;
	});
}

export function sqliteWriteFile(root: string, path: string, content: string): void {
	const filename = basename(path);
	if (filename === "JOURNEY.md") {
		sqliteWriteJourney(root, content);
		return;
	}
	const front = parseTopicFrontMatter(content);
	close(root, (db, s) => {
		db.prepare(`INSERT INTO topics(project_root, session_id, filename, id, title, summary, updated, content, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(project_root, session_id, filename) DO UPDATE SET
			id=excluded.id, title=excluded.title, summary=excluded.summary, updated=excluded.updated,
			content=excluded.content, updated_at=excluded.updated_at`).run(
			s.projectRoot,
			s.sessionId,
			filename,
			front.id ?? null,
			front.title ?? null,
			front.summary ?? null,
			front.updated ?? null,
			content,
			Date.now(),
		);
	});
}

export function sqliteListFiles(root: string): string[] {
	return close(root, (db, s) => {
		const rows = db.prepare("SELECT filename FROM topics WHERE project_root=? AND session_id=? ORDER BY filename").all(
			s.projectRoot,
			s.sessionId,
		) as Row[];
		const files = rows.map((r) => String(r.filename));
		const journey = db.prepare("SELECT body FROM journey WHERE project_root=? AND session_id=?").get(
			s.projectRoot,
			s.sessionId,
		) as Row | undefined;
		if (typeof journey?.body === "string" && journey.body.trim().length > 0) files.unshift("JOURNEY.md");
		return files;
	});
}

export function sqliteListTopics(root: string): Topic[] {
	return close(root, (db, s) => {
		const rows = db.prepare("SELECT filename,id,title,summary,updated FROM topics WHERE project_root=? AND session_id=? ORDER BY filename").all(
			s.projectRoot,
			s.sessionId,
		) as Row[];
		return rows.map((r) => ({
			filename: String(r.filename),
			path: portable(relative(s.projectRoot, join(resolve(root), String(r.filename)))),
			id: typeof r.id === "string" ? r.id : undefined,
			title: typeof r.title === "string" ? r.title : undefined,
			summary: typeof r.summary === "string" ? r.summary : undefined,
			updated: typeof r.updated === "string" ? r.updated : undefined,
		}));
	});
}

export function sqliteWriteJourney(root: string, body: string): void {
	close(root, (db, s) => {
		db.prepare(`INSERT INTO journey(project_root, session_id, body, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(project_root, session_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`).run(
			s.projectRoot,
			s.sessionId,
			body,
			Date.now(),
		);
	});
}

export function sqliteReadJourney(root: string): string | undefined {
	return close(root, (db, s) => {
		const row = db.prepare("SELECT body FROM journey WHERE project_root=? AND session_id=?").get(
			s.projectRoot,
			s.sessionId,
		) as Row | undefined;
		const body = typeof row?.body === "string" ? row.body.trim() : "";
		return body.length > 0 ? body : undefined;
	});
}

