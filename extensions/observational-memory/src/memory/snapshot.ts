import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMemorySnapshot } from "./index-render.js";
import { atomicWrite, listTopics, readJourney, snapshotPath } from "./paths.js";
import { sqliteHasScope, sqliteReadFile } from "./sqlite.js";

/** Write `.memory/<sessionId>/MEMORY.md`, a git-friendly mirror of the central SQLite state. */
export function writeMemorySnapshot(root: string): void {
	const topics = listTopics(root);
	const useSqlite = sqliteHasScope(root);
	const bodies = new Map<string, string>();
	for (const topic of topics) {
		const body = useSqlite ? sqliteReadFile(root, topic.filename) : readFileIfExists(join(root, topic.filename));
		if (body !== undefined) bodies.set(topic.filename, body);
	}
	atomicWrite(snapshotPath(root), renderMemorySnapshot(topics, bodies, readJourney(root)));
}

function readFileIfExists(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
	} catch {
		return undefined;
	}
}

