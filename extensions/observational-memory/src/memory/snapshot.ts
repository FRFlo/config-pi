import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderMemorySnapshot } from "./index-render.js";
import { atomicWrite, listTopics, readJourney, snapshotPath } from "./paths.js";
import { sqliteHasScope, sqliteReadFile } from "./sqlite.js";

/** Write `.memory/MEMORY.md`, a git-friendly mirror of the central SQLite state. */
export function writeMemorySnapshot(root: string): void {
	const topics = listTopics(root);
	const useSqlite = sqliteHasScope(root);
	const bodies = new Map<string, string>();
	for (const topic of topics) {
		const body = useSqlite ? sqliteReadFile(root, topic.filename) : readFileIfExists(join(root, topic.filename));
		if (body !== undefined) bodies.set(topic.filename, body);
	}
	const journey = readJourney(root);
	const path = snapshotPath(root);
	if (topics.length === 0 && !journey?.trim()) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	atomicWrite(path, renderMemorySnapshot(topics, bodies, journey));
}

function readFileIfExists(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
	} catch {
		return undefined;
	}
}

