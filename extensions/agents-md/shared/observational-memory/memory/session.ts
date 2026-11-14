/**
 * Per-session memory resolution + fork seeding.
 *
 * Durable long-term memory is scoped under `.memory/<sessionId>/` (see `sessionMemoryRoot`) so
 * two sessions in the same project never share consolidator output. The session id is the
 * immutable session-header UUID (survives /name, /resume, /tree) read via
 * `sessionManager.getSessionId()` — never the filename UUID (which can diverge) or the display
 * name (which /name mutates).
 *
 * On a fork/clone/new-with-parent, the short-term ledger travels with the new session, so we
 * seed the long-term tier to match: copy the parent's memory root in once, on first touch.
 * Seeding is idempotent — once the dir exists it is never re-seeded, so resume and /tree never
 * disturb it. The transient `.runs/` IPC directory is excluded.
 */
import { sessionMemoryRoot } from "./paths.js";
import { sqliteCloneScope, sqliteHasScope } from "./sqlite.js";
import { readFileSync } from "node:fs";

type SessionCtx = {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
		getHeader?: () => { id?: string; cwd?: string; parentSession?: string } | null | undefined;
	};
};

function readSessionHeaderId(file: string): string | undefined {
	try {
		const header = JSON.parse(readFileSync(file, "utf-8").split("\n", 1)[0] ?? "") as { id?: string };
		return typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/** Read a session file's header id (first JSONL line). Undefined on any parse/IO failure. */
/**
 * Resolve the parent session's memory root for fork/clone seeding, or undefined when there is
 * no parent or the parent kept no memory under this project. The parent is discovered via the
 * durable `parentSession` lineage in this session's header.
 */
function parentMemoryRoot(ctx: SessionCtx): string | undefined {
	const parentFile = ctx.sessionManager.getHeader?.()?.parentSession;
	if (!parentFile) return undefined;
	const parentId = readSessionHeaderId(parentFile);
	if (!parentId) return undefined;
	const root = sessionMemoryRoot(ctx.cwd, parentId);
	return sqliteHasScope(root) ? root : undefined;
}

/**
 * Resolve this session's `.memory/<sessionId>/` root, seeding it from the parent session on
 * first touch (fork/clone/new-with-parent). Idempotent: once the dir exists it is returned
 * untouched. Returns the absolute root. When there is no parent memory, the root is NOT created
 * here — the first durable write (INDEX/topic/journey) lazily creates it via `atomicWrite`.
 */
export function ensureSessionMemory(ctx: SessionCtx): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const root = sessionMemoryRoot(ctx.cwd, sessionId);
	const parent = parentMemoryRoot(ctx);
	if (parent) sqliteCloneScope(parent, root);
	return root;
}
