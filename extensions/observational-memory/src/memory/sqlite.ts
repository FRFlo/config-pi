import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Topic, TopicFrontMatter } from "./paths.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;
const require = createRequire(import.meta.url);

type Row = Record<string, unknown>;

const RESERVED_FILES = new Set(["INDEX.md", "JOURNEY.md", "MEMORY.md"]);
const AGENTS_PAGE_CHARS = 12_000;

function ensureColumn(db: DatabaseSync, table: "topics" | "journey", column: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
	if (!columns.some((row) => row.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
	}
}

function ensureAgentsProgressColumns(db: DatabaseSync): void {
	const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('topics','journey')").all() as Row[]).map((row) => String(row.name)));
	if (tables.has("topics")) ensureColumn(db, "topics", "agents_md_progress");
	if (tables.has("journey")) ensureColumn(db, "journey", "agents_md_progress");
}

function isReservedTopicFile(filename: string): boolean {
	return RESERVED_FILES.has(filename);
}

function parseTopicFrontMatter(content: string): TopicFrontMatter {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
	if (!match) return {};
	const front: TopicFrontMatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
		if (key === "id" || key === "title" || key === "summary" || key === "updated") front[key] = value;
	}
	return front;
}

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

function open(root: string): { db: DatabaseSync; scope: MemoryScope } {
	const dbPath = sqliteDbPath(root);
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
			agents_md_progress TEXT,
			PRIMARY KEY (project_root, session_id, filename),
			FOREIGN KEY (project_root, session_id) REFERENCES memory_scope(project_root, session_id)
		);
		CREATE TABLE IF NOT EXISTS journey (
			project_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			body TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			agents_md_progress TEXT,
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
	ensureAgentsProgressColumns(db);
	const scope = scopeFromRoot(root);
	db.prepare("INSERT OR IGNORE INTO memory_scope(project_root, session_id, created_at) VALUES (?, ?, ?)").run(
		scope.projectRoot,
		scope.sessionId,
		Date.now(),
	);
	db.prepare("DELETE FROM topics WHERE project_root=? AND session_id=? AND filename='MEMORY.md'").run(
		scope.projectRoot,
		scope.sessionId,
	);
	migrateLegacyAgentsProgress(db, scope.projectRoot);
	return { db, scope };
}

function openRaw(root: string): { db: DatabaseSync; scope: MemoryScope } {
	const dbPath = sqliteDbPath(root);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return { db: new DatabaseSync(dbPath), scope: scopeFromRoot(root) };
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

/** Clone durable memory from a parent session into a forked session. */
export function sqliteCloneScope(parentRoot: string, childRoot: string): void {
	const parent = scopeFromRoot(parentRoot);
	const child = scopeFromRoot(childRoot);
	close(childRoot, (db) => {
		db.exec("BEGIN");
		try {
			db.prepare(`INSERT OR IGNORE INTO topics(
				project_root, session_id, filename, id, title, summary, updated, content, updated_at, agents_md_progress
			) SELECT ?, ?, filename, id, title, summary, updated, content, updated_at, agents_md_progress
			FROM topics WHERE project_root=? AND session_id=?`).run(
				child.projectRoot, child.sessionId, parent.projectRoot, parent.sessionId,
			);
			db.prepare(`INSERT OR IGNORE INTO journey(project_root, session_id, body, updated_at, agents_md_progress)
				SELECT ?, ?, body, updated_at, agents_md_progress FROM journey
				WHERE project_root=? AND session_id=?`).run(
				child.projectRoot, child.sessionId, parent.projectRoot, parent.sessionId,
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
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
	if (isReservedTopicFile(filename)) return undefined;
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
	if (isReservedTopicFile(filename)) return;
	const front = parseTopicFrontMatter(content);
	close(root, (db, s) => {
		db.prepare(`INSERT INTO topics(project_root, session_id, filename, id, title, summary, updated, content, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(project_root, session_id, filename) DO UPDATE SET
			id=excluded.id, title=excluded.title, summary=excluded.summary, updated=excluded.updated,
			agents_md_progress=CASE WHEN topics.content=excluded.content THEN topics.agents_md_progress ELSE NULL END,
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
		const files = rows.map((r) => String(r.filename)).filter((filename) => !isReservedTopicFile(filename));
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
		return rows.filter((r) => !isReservedTopicFile(String(r.filename))).map((r) => ({
			filename: String(r.filename),
			path: portable(relative(s.projectRoot, join(resolve(root), String(r.filename)))),
			id: typeof r.id === "string" ? r.id : undefined,
			title: typeof r.title === "string" ? r.title : undefined,
			summary: typeof r.summary === "string" ? r.summary : undefined,
			updated: typeof r.updated === "string" ? r.updated : undefined,
		}));
	});
}

/** Read consolidated memories from every session belonging to one project. */
export function sqliteReadProjectMemories(projectRoot: string): Array<{ sessionId: string; filename: string; content: string }> {
	const dbPath = process.env.PI_OM_SQLITE_PATH || join(getAgentDir(), "observational-memory.sqlite");
	if (!existsSync(dbPath)) return [];
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('topics','journey')").all() as Row[]).map((row) => String(row.name)));
		const rows = tables.has("topics")
			? db.prepare("SELECT session_id, filename, content FROM topics WHERE project_root=? ORDER BY session_id, filename").all(resolve(projectRoot)) as Row[]
			: [];
		const journeyRows = tables.has("journey")
			? db.prepare("SELECT session_id, body FROM journey WHERE project_root=? ORDER BY session_id").all(resolve(projectRoot)) as Row[]
			: [];
		const memories = rows.map((row) => ({
			sessionId: String(row.session_id),
			filename: String(row.filename),
			content: String(row.content),
		}));
		for (const row of journeyRows) {
			if (typeof row.body === "string" && row.body.trim()) {
				memories.push({ sessionId: String(row.session_id), filename: "JOURNEY.md", content: row.body });
			}
		}
		return memories;
	} finally {
		db.close();
	}
}

export type AgentsMemoryPage = {
	pageId: string;
	sourceHash: string;
	memoryHash: string;
	sessionId: string;
	filename: string;
	partIndex: number;
	totalParts: number;
	processed: boolean;
	outcome?: string;
	notes?: string;
};

type MemoryPageContent = Omit<AgentsMemoryPage, "processed" | "outcome" | "notes"> & {
	content: string;
	processed: boolean;
};

function openAgentsProjectDb(projectRoot: string): { db: DatabaseSync; root: string } {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(sqliteDbPath(projectRoot));
	db.exec("PRAGMA journal_mode = WAL");
	ensureAgentsProgressColumns(db);
	const root = resolve(projectRoot);
	migrateLegacyAgentsProgress(db, root);
	return { db, root };
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

type ProjectMemoryRow = { sessionId: string; filename: string; content: string; progress?: string };

function projectMemoryRows(db: DatabaseSync, root: string, offset: number, limit: number): ProjectMemoryRow[] {
	const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('topics','journey')").all() as Row[]).map((row) => String(row.name)));
	const sources: string[] = [];
	if (tables.has("topics")) {
		sources.push(`SELECT session_id, filename, content, agents_md_progress
			FROM topics WHERE project_root=? AND filename NOT IN ('INDEX.md','JOURNEY.md','MEMORY.md')`);
	}
	if (tables.has("journey")) {
		sources.push(`SELECT session_id, 'JOURNEY.md' AS filename, body AS content, agents_md_progress
			FROM journey WHERE project_root=? AND trim(body)<>''`);
	}
	if (sources.length === 0) return [];
	const rows = db.prepare(`SELECT session_id, filename, content, agents_md_progress FROM (
		${sources.join(" UNION ALL ")}
	) ORDER BY session_id, filename LIMIT ? OFFSET ?`).all(
		...sources.map(() => root),
		Math.max(1, Math.trunc(limit)),
		Math.max(0, Math.trunc(offset)),
	) as Row[];
	return rows.map((row) => ({
		sessionId: String(row.session_id),
		filename: String(row.filename),
		content: String(row.content),
		progress: typeof row.agents_md_progress === "string" ? row.agents_md_progress : undefined,
	}));
}

function allProjectMemoryRows(db: DatabaseSync, root: string): ProjectMemoryRow[] {
	const rows: ProjectMemoryRow[] = [];
	const batchSize = 100;
	let offset = 0;
	while (true) {
		const batch = projectMemoryRows(db, root, offset, batchSize);
		rows.push(...batch);
		if (batch.length < batchSize) return rows;
		offset += batch.length;
	}
}

type MemoryPageInternal = Omit<AgentsMemoryPage, "processed" | "outcome" | "notes"> & {
	content: string;
	processed: boolean;
	outcome?: string;
	notes?: string;
};

type StoredMemoryProgress = {
	memoryHash: string;
	parts: Record<string, {
		sourceHash: string;
		outcome?: string;
		notes?: string;
		readAt?: number;
		processedAt?: number;
	}>;
};

function readStoredProgress(serialized: string | undefined, memoryHash: string): StoredMemoryProgress {
	if (!serialized) return { memoryHash, parts: {} };
	try {
		const parsed = JSON.parse(serialized) as StoredMemoryProgress;
		if (parsed.memoryHash === memoryHash && parsed.parts && typeof parsed.parts === "object") return parsed;
	} catch {
		// Invalid or outdated progress is treated as unprocessed.
	}
	return { memoryHash, parts: {} };
}

function buildAgentsMemoryPages(rows: ProjectMemoryRow[]): MemoryPageInternal[] {
	const pages: MemoryPageInternal[] = [];
	for (const row of rows) {
		if (!row.content.trim()) continue;
		const memoryHash = digest(row.content);
		const progress = readStoredProgress(row.progress, memoryHash);
		const chunks: string[] = [];
		for (let start = 0; start < row.content.length;) {
			let end = Math.min(start + AGENTS_PAGE_CHARS, row.content.length);
			if (end < row.content.length && row.content.charCodeAt(end - 1) >= 0xd800 && row.content.charCodeAt(end - 1) <= 0xdbff) {
				end--;
			}
			chunks.push(row.content.slice(start, end));
			start = end;
		}
		for (let partIndex = 0; partIndex < chunks.length; partIndex++) {
			const content = chunks[partIndex];
			const sourceHash = digest(content);
			const partProgress = progress.parts[String(partIndex)];
			const processed = partProgress?.sourceHash === sourceHash && typeof partProgress.processedAt === "number";
			const key = `${row.sessionId}\0${row.filename}\0${partIndex}`;
			pages.push({
				pageId: digest(key),
				sourceHash,
				memoryHash,
				sessionId: row.sessionId,
				filename: row.filename,
				partIndex,
				totalParts: chunks.length,
				content,
				processed,
				outcome: processed ? partProgress?.outcome : undefined,
				notes: processed ? partProgress?.notes : undefined,
			});
		}
	}
	return pages;
}

function revisionForPages(pages: ReturnType<typeof buildAgentsMemoryPages>): string {
	return digest(JSON.stringify(pages.map(({ pageId, sourceHash }) => [pageId, sourceHash])));
}

/** Prepare a paginated project pass, resuming partial work recorded on each memory row. */
export function sqliteBeginAgentsMemoryRun(projectRoot: string, requestedMode: "full" | "incremental"): {
	revision: string;
	mode: "full" | "incremental";
	pages: AgentsMemoryPage[];
} {
	const { db, root } = openAgentsProjectDb(projectRoot);
	try {
		let pages = buildAgentsMemoryPages(allProjectMemoryRows(db, root));
		if (requestedMode === "full" && pages.length > 0 && pages.every((page) => page.processed)) {
			const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('topics','journey')").all() as Row[]).map((row) => String(row.name)));
			if (tables.has("topics")) db.prepare("UPDATE topics SET agents_md_progress=NULL WHERE project_root=?").run(root);
			if (tables.has("journey")) db.prepare("UPDATE journey SET agents_md_progress=NULL WHERE project_root=?").run(root);
			pages = buildAgentsMemoryPages(allProjectMemoryRows(db, root));
		}
		const mode = requestedMode === "full" && pages.some((page) => !page.processed) ? "full" : requestedMode;
		return {
			revision: revisionForPages(pages),
			mode,
			pages: pages.map(({ content: _content, ...page }) => page),
		};
	} finally {
		db.close();
	}
}

/** Return current page metadata in stable order, including completion notes. */
export function sqliteListAgentsMemoryPages(projectRoot: string, offset = 0, limit = 20): {
	revision: string;
	totalPages: number;
	pages: AgentsMemoryPage[];
} {
	const { db, root } = openAgentsProjectDb(projectRoot);
	try {
		const pages = buildAgentsMemoryPages(allProjectMemoryRows(db, root));
		const revision = revisionForPages(pages);
		const start = Math.max(0, Math.trunc(offset));
		const pageLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
		return {
			revision,
			totalPages: pages.length,
			pages: pages.slice(start, start + pageLimit).map(({ content: _content, ...page }) => page),
		};
	} finally {
		db.close();
	}
}

function writeMemoryProgress(db: DatabaseSync, root: string, row: ProjectMemoryRow, progress: StoredMemoryProgress): void {
	const serialized = JSON.stringify(progress);
	row.progress = serialized;
	if (row.filename === "JOURNEY.md") {
		db.prepare("UPDATE journey SET agents_md_progress=? WHERE project_root=? AND session_id=?").run(
			serialized, root, row.sessionId,
		);
	} else {
		db.prepare("UPDATE topics SET agents_md_progress=? WHERE project_root=? AND session_id=? AND filename=?").run(
			serialized, root, row.sessionId, row.filename,
		);
	}
}

/** Move progress from the short-lived table-based implementation into memory rows, then remove it. */
function migrateLegacyAgentsProgress(db: DatabaseSync, root: string): void {
	const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents_md_memory_pages','agents_md_memory_runs')").all() as Row[]).map((row) => String(row.name)));
	if (!tables.size) return;

	const requiredColumns: Record<string, string[]> = {
		agents_md_memory_pages: ["project_root", "page_id", "source_hash", "session_id", "filename", "part_index", "processed_at", "outcome", "notes"],
		agents_md_memory_runs: ["project_root", "revision", "mode", "status", "updated_at"],
	};
	for (const table of tables) {
		const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)));
		if (requiredColumns[table]?.some((column) => !columns.has(column))) return;
	}

	db.exec("BEGIN IMMEDIATE");
	try {
		if (tables.has("agents_md_memory_pages")) {
			const legacy = db.prepare(`SELECT page_id, source_hash, session_id, filename, part_index, processed_at, outcome, notes
				FROM agents_md_memory_pages WHERE project_root=? AND processed_at IS NOT NULL`).all(root) as Row[];
			const rows = allProjectMemoryRows(db, root);
			const pages = buildAgentsMemoryPages(rows);
			for (const item of legacy) {
				const page = pages.find((candidate) =>
					candidate.pageId === item.page_id &&
					candidate.sourceHash === item.source_hash &&
					candidate.sessionId === item.session_id &&
					candidate.filename === item.filename,
				);
				if (!page || typeof item.processed_at !== "number") continue;
				const row = rows.find((candidate) => candidate.sessionId === page.sessionId && candidate.filename === page.filename);
				if (!row) continue;
				const progress = readStoredProgress(row.progress, page.memoryHash);
				progress.parts[String(page.partIndex)] = {
					sourceHash: page.sourceHash,
					outcome: typeof item.outcome === "string" ? item.outcome : "processed",
					notes: typeof item.notes === "string" ? item.notes : "",
					processedAt: item.processed_at,
				};
				writeMemoryProgress(db, root, row, progress);
			}
		}

		db.exec("DROP TABLE IF EXISTS agents_md_memory_pages; DROP TABLE IF EXISTS agents_md_memory_runs;");
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** Read one memory page and persist its read marker on the source row. */
export function sqliteReadAgentsMemoryPage(projectRoot: string, pageId: string): MemoryPageContent | undefined {
	const { db, root } = openAgentsProjectDb(projectRoot);
	try {
		const rows = allProjectMemoryRows(db, root);
		const pages = buildAgentsMemoryPages(rows);
		const page = pages.find((entry) => entry.pageId === pageId);
		if (!page) return undefined;
		const row = rows.find((entry) => entry.sessionId === page.sessionId && entry.filename === page.filename);
		if (!row || digest(row.content) !== page.memoryHash) return undefined;
		const progress = readStoredProgress(row.progress, page.memoryHash);
		const key = String(page.partIndex);
		const prior = progress.parts[key];
		const now = Math.max(Date.now(), (prior?.readAt ?? 0) + 1, (prior?.processedAt ?? 0) + 1);
		progress.parts[key] = {
			...prior,
			sourceHash: page.sourceHash,
			readAt: now,
		};
		writeMemoryProgress(db, root, row, progress);
		const { content, ...metadata } = page;
		return { ...metadata, processed: page.processed, content };
	} finally {
		db.close();
	}
}

/** Mark a page complete only after it has been read in the current attempt. */
export function sqliteMarkAgentsMemoryPageProcessed(
	projectRoot: string,
	pageId: string,
	sourceHash: string,
	outcome: string,
	notes: string,
): boolean {
	const { db, root } = openAgentsProjectDb(projectRoot);
	try {
		const rows = allProjectMemoryRows(db, root);
		const pages = buildAgentsMemoryPages(rows);
		const page = pages.find((entry) => entry.pageId === pageId && entry.sourceHash === sourceHash);
		if (!page) return false;
		const row = rows.find((entry) => entry.sessionId === page.sessionId && entry.filename === page.filename);
		if (!row || digest(row.content) !== page.memoryHash) return false;
		const progress = readStoredProgress(row.progress, page.memoryHash);
		const key = String(page.partIndex);
		const prior = progress.parts[key];
		if (prior?.sourceHash !== sourceHash || typeof prior.readAt !== "number" || prior.readAt <= (prior.processedAt ?? 0)) return false;
		progress.parts[key] = {
			...prior,
			sourceHash,
			outcome: outcome.slice(0, 80),
			notes: notes.slice(0, 1000),
			processedAt: Date.now(),
		};
		writeMemoryProgress(db, root, row, progress);
		return true;
	} finally {
		db.close();
	}
}

/** Finish the current pass only when every current page has been acknowledged. */
export function sqliteFinishAgentsMemoryRun(projectRoot: string, revision: string): boolean {
	const { db, root } = openAgentsProjectDb(projectRoot);
	try {
		const pages = buildAgentsMemoryPages(allProjectMemoryRows(db, root));
		return revisionForPages(pages) === revision && pages.every((page) => page.processed);
	} finally {
		db.close();
	}
}

export function sqliteWriteJourney(root: string, body: string): void {
	close(root, (db, s) => {
		db.prepare(`INSERT INTO journey(project_root, session_id, body, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(project_root, session_id) DO UPDATE SET
			agents_md_progress=CASE WHEN journey.body=excluded.body THEN journey.agents_md_progress ELSE NULL END,
			body=excluded.body, updated_at=excluded.updated_at`).run(
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

