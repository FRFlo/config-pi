import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfiguredModel } from "../../observational-memory/src/config.js";
import { loadConfig } from "../../observational-memory/src/config.js";
import {
	sqliteBeginAgentsMemoryRun,
	sqliteFinishAgentsMemoryRun,
	sqliteListAgentsMemoryPages,
	sqliteListFiles,
	sqliteReadFile,
} from "../../observational-memory/src/memory/sqlite.js";
import { buildWorkerArgv, spawnWorker } from "../../observational-memory/src/spawn/launch.js";

const WORKER_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "index.ts");

const SKIP_DIRS = new Set([".git", ".memory", "node_modules", "dist", "build", "coverage"]);
const EXISTING_CONTEXT_BUDGET = 24_000;
const EXISTING_FILE_CONTEXT_LIMIT = 8_000;

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function readSafeAgentsFile(root: string, target: string): string {
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Project root is not a real directory.");
	const rel = relative(root, target);
	if (!isInside(root, target) || !rel) throw new Error("AGENTS.md target is outside the project root.");
	let current = root;
	const components = rel.split(/[\\/]/);
	for (let index = 0; index < components.length; index++) {
		current = resolve(current, components[index]);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error("Symbolic-link AGENTS.md paths are not allowed.");
		if (index < components.length - 1 && !stat.isDirectory()) throw new Error("AGENTS.md parent is not a directory.");
		if (index === components.length - 1 && !stat.isFile()) throw new Error("AGENTS.md target is not a regular file.");
	}

	const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const pathStat = lstatSync(target);
		const fileStat = fstatSync(fd);
		if (pathStat.isSymbolicLink() || pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
			throw new Error("AGENTS.md target changed during validation.");
		}
		const realRoot = realpathSync(root);
		const realTarget = realpathSync(target);
		if (!isInside(realRoot, realTarget)) throw new Error("AGENTS.md target resolves outside the project root.");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

function gitIgnoredPaths(root: string, paths: string[]): Set<string> {
	const ignored = new Set<string>();
	for (let i = 0; i < paths.length; i += 500) {
		const batch = paths.slice(i, i + 500);
		const relativePaths = batch.map((path) => relative(root, path).replace(/\\/g, "/"));
		const result = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
			cwd: root,
			input: `${relativePaths.join("\0")}\0`,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 10 * 1024 * 1024,
		});
		// Outside a Git worktree (or without git installed), retain the static exclusions only.
		if (result.error || result.status === 128) continue;
		for (const path of result.stdout.split("\0")) {
			if (path) ignored.add(path.replace(/\\/g, "/").replace(/\/$/, ""));
		}
	}
	return ignored;
}

export function findAgentsFiles(projectRoot: string): string[] {
	const root = resolve(projectRoot);
	const result = new Set<string>();
	result.add(resolve(root, "AGENTS.md"));
	let level = [root];
	while (level.length > 0) {
		const directories: string[] = [];
		for (const dir of level) {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (SKIP_DIRS.has(name)) continue;
				const full = resolve(dir, name);
				try {
					const stat = lstatSync(full);
					if (stat.isSymbolicLink()) continue;
					if (stat.isDirectory()) directories.push(full);
					else if (name === "AGENTS.md") result.add(full);
				} catch {
					// Ignore unreadable or concurrently removed paths.
				}
			}
		}
		const ignored = gitIgnoredPaths(root, directories);
		level = directories.filter((dir) => {
			const rel = relative(root, dir).replace(/\\/g, "/");
			if (ignored.has(rel)) return false;
			result.add(resolve(dir, "AGENTS.md"));
			return true;
		});
	}
	const ignoredFiles = gitIgnoredPaths(root, [...result]);
	return [...result].filter((file) => !ignoredFiles.has(relative(root, file).replace(/\\/g, "/"))).sort();
}

export async function updateAgentsMd(
	options: { memoryRoot: string; model: ConfiguredModel },
	projectRoot: string,
	mode: { rebuild: boolean },
): Promise<void> {
	const root = resolve(projectRoot);
	const targets = findAgentsFiles(root);
	void options.memoryRoot;
	const run = sqliteBeginAgentsMemoryRun(root, mode.rebuild ? "full" : "incremental");
	const rebuildSeed = run.mode === "full" && !run.pages.some((page) => page.processed);
	let processedThisRun = 0;

	for (let index = 0; index < run.pages.length; index++) {
		const page = run.pages[index];
		if (page.processed) continue;
		const isSeed = rebuildSeed && processedThisRun === 0;
		const existingContents = new Map<string, string>();
		const readOnlyTargets = new Set<string>();
		let existingBudget = EXISTING_CONTEXT_BUDGET;
		if (!isSeed) {
			for (const target of targets) {
				try {
					const content = readSafeAgentsFile(root, target);
					if (content.length > EXISTING_FILE_CONTEXT_LIMIT || content.length > existingBudget) {
						readOnlyTargets.add(target);
						continue;
					}
					existingContents.set(target, content);
					existingBudget -= content.length;
				} catch {
					try {
						lstatSync(target);
						readOnlyTargets.add(target);
					} catch {
						// New candidates have no baseline content to include.
					}
				}
			}
		}
		const writableTargets = targets.filter((target) => !readOnlyTargets.has(target));
		const existing = [...existingContents]
			.map(([target, content]) => `\n\n### Existing ${relative(root, target) || "AGENTS.md"}\n${content}`)
			.join("");
		let directoryContextBudget = 24_000;
		const targetContext = targets
			.map((target) => {
				const isRoot = target === resolve(root, "AGENTS.md");
				let exists = existingContents.has(target) || readOnlyTargets.has(target);
				if (!exists) {
					try {
						exists = lstatSync(target).isFile();
					} catch {
						// Missing candidate.
					}
				}
				const guidance = readOnlyTargets.has(target)
					? "existing file, read-only for this page (contents omitted due to context budget)"
					: isRoot ? "project-wide root" : exists ? "existing file" : "optional candidate";
				let context = "";
				if (!isRoot && directoryContextBudget > 0) {
					try {
						const entries = readdirSync(dirname(target), { withFileTypes: true });
						const names = entries.slice(0, 16).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
						context = `; directory contents: ${names.join(", ")}${entries.length > names.length ? ", …" : ""}`;
					} catch {
						// Directory may have changed since target discovery.
					}
					directoryContextBudget -= context.length;
				}
				return `- ${relative(root, target) || "AGENTS.md"} (${guidance}${context})`;
			})
			.join("\n");
		const status = sqliteListAgentsMemoryPages(root, index, 1);
		const history = run.pages
			.slice(0, index)
			.filter((prior) => prior.processed)
			.slice(-8)
			.map((prior) => `- ${prior.pageId}: ${prior.outcome ?? "processed"} — ${prior.notes ?? "(no note)"}`)
			.join("\n");
		const prompt =
			`Project root: ${root}\n` +
			`Run mode: ${isSeed ? "full rebuild seed; later workers will incorporate the remaining pages" : run.mode === "full" ? "continuing full rebuild" : "incremental update"}\n` +
			`Assigned memory page ${index + 1} of ${status.totalPages}: ${page.pageId}\n` +
			`Source: session ${page.sessionId}, ${page.filename}${page.totalParts > 1 ? ` (part ${page.partIndex + 1}/${page.totalParts})` : ""}\n` +
			`Read this page with read_memory_page before deciding. Acknowledge only after any file writes succeed.\n\n` +
			`AGENTS.md targets (existing files are preserved unless this is the full-rebuild seed; candidates are optional; read-only targets cannot be written):\n${targetContext}\n\n` +
			`Existing AGENTS.md contents:${existing || "\n(none; start this rebuild seed from verified memory only)"}\n\n` +
			`Recent processed-page notes:\n${history || "(none)"}`;
		const runId = `agents-${Date.now()}-${process.pid}-${index}`;
		const argv = buildWorkerArgv({
			model: options.model,
			sessionName: `om-agents-${runId}`,
			kickoffPrompt: prompt,
			agentExtensionPath: WORKER_EXTENSION,
		});
		const env = {
			...process.env,
			OM_WORKER: "agents-md",
			OM_PROJECT_ROOT: root,
			OM_AGENTS_TARGETS: JSON.stringify(writableTargets),
		};
		const exit = await spawnWorker({ argv, cwd: root, env, stdin: prompt });
		if (exit.code !== 0) {
			throw new Error(`AGENTS.md page worker exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 300)}` : ""}`);
		}
		const after = sqliteListAgentsMemoryPages(root, index, 1);
		if (after.pages[0]?.pageId !== page.pageId || !after.pages[0].processed) {
			throw new Error(`AGENTS.md page ${page.pageId} was not acknowledged; it will be retried.`);
		}
		processedThisRun++;
	}

	if (!sqliteFinishAgentsMemoryRun(root, run.revision)) {
		throw new Error("AGENTS.md memory inventory changed during processing; rerun to process the updated memories.");
	}
}

export function registerAgentsMdCommands(pi: ExtensionAPI): void {
	pi.registerCommand("om:agents", {
		description: "Incrementally update AGENTS.md files from all project sessions' memories",
		handler: async (_args: string, ctx: any) => {
			const memoryRoot = resolve(ctx.cwd, ".memory", ctx.sessionManager.getSessionId());
			try {
				await updateAgentsMd({ memoryRoot, model: loadConfig(ctx.cwd).models.consolidator }, ctx.cwd, { rebuild: false });
				if (ctx.hasUI) ctx.ui.notify("om: AGENTS.md files updated from new or changed memories across all project sessions", "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`om: AGENTS.md update failed: ${String(error)}`, "error");
			}
		},
	});
	pi.registerCommand("om:agents:all", {
		description: "Rebuild AGENTS.md files from all project sessions' memories",
		handler: async (_args: string, ctx: any) => {
			const memoryRoot = resolve(ctx.cwd, ".memory", ctx.sessionManager.getSessionId());
			try {
				await updateAgentsMd({ memoryRoot, model: loadConfig(ctx.cwd).models.consolidator }, ctx.cwd, { rebuild: true });
				if (ctx.hasUI) ctx.ui.notify("om: AGENTS.md files rebuilt from all project sessions", "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`om: AGENTS.md update failed: ${String(error)}`, "error");
			}
		},
	});
}
