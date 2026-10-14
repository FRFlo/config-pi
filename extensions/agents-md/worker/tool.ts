import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import {
	sqliteListAgentsMemoryPages,
	sqliteMarkAgentsMemoryPageProcessed,
	sqliteReadAgentsMemoryPage,
} from "../../observational-memory/src/memory/sqlite.js";

const Schema = Type.Object({
	path: Type.String(),
	content: Type.String(),
});
type Input = Static<typeof Schema>;

function assertSafeTarget(root: string, target: string): void {
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Project root is not a real directory.");
	const relativeTarget = relative(root, target);
	if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
		throw new Error("Target is outside the project root.");
	}

	let current = root;
	const components = relativeTarget.split(/[\\/]/);
	for (let index = 0; index < components.length; index++) {
		current = resolve(current, components[index]);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error("Symbolic-link targets are not allowed.");
			if (index < components.length - 1 && !stat.isDirectory()) throw new Error("Target parent is not a directory.");
			if (index === components.length - 1 && !stat.isFile()) throw new Error("Target is not a regular file.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === components.length - 1) continue;
			throw error;
		}
	}

	const realRoot = realpathSync(root);
	const realParent = realpathSync(dirname(target));
	const parentRelative = relative(realRoot, realParent);
	if (isAbsolute(parentRelative) || parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
		throw new Error("Target parent resolves outside the project root.");
	}
}

export function registerAgentsMdTool(pi: ExtensionAPI): void {
	const rootValue = process.env.OM_PROJECT_ROOT;
	if (!rootValue) throw new Error("AGENTS.md project root is required");
	const root = resolve(rootValue);
	const targets = new Set<string>(JSON.parse(process.env.OM_AGENTS_TARGETS ?? "[]"));

	pi.registerTool({
		name: "write_agents_file",
		label: "Write AGENTS.md",
		description: "Replace one explicitly listed AGENTS.md file with the generated instructions.",
		parameters: Schema,
		async execute(_id: string, params: Input) {
			const target = resolve(root, params.path);
			const rel = relative(root, target);
			if (!targets.has(target) || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
				return { content: [{ type: "text" as const, text: "Error: target is not in the allowed AGENTS.md list." }], details: { error: true } };
			}
			if (!target.endsWith("AGENTS.md")) {
				return { content: [{ type: "text" as const, text: "Error: only AGENTS.md targets are allowed." }], details: { error: true } };
			}
			let fd: number | undefined;
			try {
				assertSafeTarget(root, target);
				const noFollow = constants.O_NOFOLLOW ?? 0;
				fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | noFollow, 0o666);
				const targetStat = lstatSync(target);
				const openedStat = fstatSync(fd);
				if (targetStat.isSymbolicLink() || targetStat.dev !== openedStat.dev || targetStat.ino !== openedStat.ino) {
					throw new Error("Target changed during validation.");
				}
				const realRoot = realpathSync(root);
				const realTarget = realpathSync(target);
				const targetRelative = relative(realRoot, realTarget);
				if (isAbsolute(targetRelative) || targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) {
					throw new Error("Target resolved outside the project root.");
				}
				ftruncateSync(fd, 0);
				writeFileSync(fd, params.content, "utf8");
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${String(error)}` }],
					details: { error: true },
				};
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
			return { content: [{ type: "text" as const, text: `Replaced ${params.path}.` }], details: { error: false } };
		},
	});

	pi.registerTool({
		name: "list_memory_pages",
		label: "List memory pages",
		description: "List paginated cross-session memory metadata, including processed status and notes. Use offsets to inspect earlier or later pages.",
		parameters: Type.Object({ offset: Type.Number(), limit: Type.Number() }),
		async execute(_id: string, params: { offset: number; limit: number }) {
			const result = sqliteListAgentsMemoryPages(root, params.offset, params.limit);
			return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "read_memory_page",
		label: "Read memory page",
		description: "Read one cross-session memory page by pageId. Previously processed pages may be revisited.",
		parameters: Type.Object({ pageId: Type.String() }),
		async execute(_id: string, params: { pageId: string }) {
			const page = sqliteReadAgentsMemoryPage(root, params.pageId);
			if (!page) {
				return {
					content: [{ type: "text" as const, text: "Memory page not found; the memory inventory may have changed." }],
					details: { error: true, pageId: "", sourceHash: "" },
				};
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }],
				details: { error: false, pageId: page.pageId, sourceHash: page.sourceHash },
			};
		},
	});

	pi.registerTool({
		name: "mark_memory_page_processed",
		label: "Mark memory page processed",
		description: "Acknowledge a page after any useful AGENTS.md updates have been written, or after deciding it contains nothing useful.",
		parameters: Type.Object({
			pageId: Type.String(),
			sourceHash: Type.String(),
			outcome: Type.String(),
			notes: Type.String(),
		}),
		async execute(_id: string, params: { pageId: string; sourceHash: string; outcome: string; notes: string }) {
			const marked = sqliteMarkAgentsMemoryPageProcessed(root, params.pageId, params.sourceHash, params.outcome, params.notes);
			return {
				content: [{ type: "text" as const, text: marked ? `Marked ${params.pageId} processed.` : "Could not acknowledge page: read it first; its contents may have changed." }],
				details: { error: !marked, processed: marked },
			};
		},
	});
}
