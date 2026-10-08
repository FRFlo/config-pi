import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const setupDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
let startupCheckRunning = false;

async function updateSetup(pi: ExtensionAPI): Promise<{ updated: boolean; message: string }> {
	const status = await pi.exec("git", ["status", "--porcelain"], { cwd: setupDir, timeout: 10_000 });
	if (status.code !== 0) return { updated: false, message: status.stderr || "Impossible de vérifier l’état Git." };
	if (status.stdout.trim()) {
		return { updated: false, message: "Mise à jour ignorée : le dépôt setup contient des modifications locales." };
	}

	const pull = await pi.exec("git", ["pull", "--ff-only"], { cwd: setupDir, timeout: 60_000 });
	if (pull.code !== 0) return { updated: false, message: pull.stderr || pull.stdout || "git pull a échoué." };
	const output = `${pull.stdout}\n${pull.stderr}`;
	const updated = !/Already up to date|Already up-to-date/i.test(output);
	return { updated, message: updated ? "Setup pi mis à jour." : "Setup pi déjà à jour." };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("update", {
		description: "Met à jour le setup pi avec git pull et recharge pi",
		handler: async (_args, ctx) => {
			const result = await updateSetup(pi);
			ctx.ui.notify(result.message, result.updated ? "info" : "warning");
			if (result.updated) await ctx.reload();
		},
	});

	pi.registerCommand("auto-update-reload", {
		description: "Recharge pi après une mise à jour automatique",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.on("session_start", async (event) => {
		if (event.reason === "reload" || startupCheckRunning) return;
		startupCheckRunning = true;
		try {
			const result = await updateSetup(pi);
			if (result.updated) {
				pi.sendUserMessage("/auto-update-reload", { deliverAs: "followUp", expandPromptTemplates: true });
			} else if (!result.message.includes("déjà à jour")) {
				console.warn(`[pi auto-update] ${result.message}`);
			}
		} catch (error) {
			console.warn(`[pi auto-update] ${String(error)}`);
		} finally {
			startupCheckRunning = false;
		}
	});
}
