import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface UserPreferences {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	theme?: string;
	hideThinkingBlock?: boolean;
	discordBridge?: {
		enabled?: boolean;
		endpoint?: string;
		apiKey?: string;
		timeoutSeconds?: number;
		channelId?: string;
	};
	mcp?: {
		context7ApiKey?: string;
		[key: string]: unknown;
	};
	"observational-memory"?: {
		backend?: string;
		models?: {
			observer?: { provider?: string; id?: string };
			consolidator?: { provider?: string; id?: string };
		};
		[key: string]: unknown;
	};
	webSearch?: {
		provider?: string;
		model?: string;
	};
	terminal?: Record<string, unknown>;
	shellPath?: string;
	[key: string]: unknown;
}

let cachedPreferences: UserPreferences | null = null;

export function getPreferencesPath(cwd?: string): string {
	if (cwd) {
		const projectPath = path.join(cwd, ".pi", "preferences.json");
		if (fs.existsSync(projectPath)) return projectPath;
	}
	return path.join(os.homedir(), ".pi", "agent", "preferences.json");
}

export function loadUserPreferences(cwd?: string, forceReload = false): UserPreferences {
	if (cachedPreferences && !forceReload) {
		return cachedPreferences;
	}

	const prefs: UserPreferences = {};
	const globalPath = path.join(os.homedir(), ".pi", "agent", "preferences.json");

	try {
		if (fs.existsSync(globalPath)) {
			const raw = fs.readFileSync(globalPath, "utf-8");
			Object.assign(prefs, JSON.parse(raw));
		}
	} catch (err) {
		console.error("[preferences-loader] Erreur lors de la lecture des préférences globales:", err);
	}

	if (cwd) {
		try {
			const projectPath = path.join(cwd, ".pi", "preferences.json");
			if (fs.existsSync(projectPath)) {
				const raw = fs.readFileSync(projectPath, "utf-8");
				Object.assign(prefs, JSON.parse(raw));
			}
		} catch (err) {
			console.error("[preferences-loader] Erreur lors de la lecture des préférences projet:", err);
		}
	}

	cachedPreferences = prefs;
	applyEnvInjection(prefs);
	return prefs;
}

export function applyEnvInjection(prefs: UserPreferences): void {
	// Inject Context7 API key for MCP
	if (prefs.mcp?.context7ApiKey && !process.env.CONTEXT7_API_KEY) {
		process.env.CONTEXT7_API_KEY = prefs.mcp.context7ApiKey;
	}

	// Inject Discord Bridge environment
	if (prefs.discordBridge?.apiKey && !process.env.PI_BRIDGE_API_KEY) {
		process.env.PI_BRIDGE_API_KEY = prefs.discordBridge.apiKey;
	}
	if (prefs.discordBridge?.endpoint && !process.env.PI_BRIDGE_ENDPOINT) {
		process.env.PI_BRIDGE_ENDPOINT = prefs.discordBridge.endpoint;
	}
	if (prefs.discordBridge?.channelId && !process.env.PI_BRIDGE_CHANNEL_ID) {
		process.env.PI_BRIDGE_CHANNEL_ID = prefs.discordBridge.channelId;
	}
}

// Initialise eagerly on module import
loadUserPreferences();

export default function preferencesLoaderExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const prefs = loadUserPreferences(ctx.cwd, true);

		// Apply model if configured in preferences and model is available
		if (prefs.defaultProvider && prefs.defaultModel) {
			const currentModel = ctx.model;
			if (
				!currentModel ||
				currentModel.provider !== prefs.defaultProvider ||
				currentModel.id !== prefs.defaultModel
			) {
				const target = `${prefs.defaultProvider}/${prefs.defaultModel}`;
				try {
					const model = ctx.modelRegistry.find(prefs.defaultProvider, prefs.defaultModel);
					if (model) {
						await pi.setModel(model);
					}
				} catch {
					// Fallback silently if model registry not ready
				}
			}
		}
	});

	pi.registerCommand("preferences", {
		description: "Recharger et afficher l'état des préférences locales",
		handler: async (_args, ctx) => {
			const prefs = loadUserPreferences(ctx.cwd, true);
			const prefPath = getPreferencesPath(ctx.cwd);
			const exists = fs.existsSync(prefPath);

			const summary = [
				`Fichier : ${prefPath} (${exists ? "présent" : "absent"})`,
				`Provider par défaut : ${prefs.defaultProvider ?? "(non défini)"}`,
				`Modèle par défaut : ${prefs.defaultModel ?? "(non défini)"}`,
				`Thème : ${prefs.theme ?? "(non défini)"}`,
				`Discord Bridge : ${prefs.discordBridge?.enabled ? "activé" : "désactivé"}`,
				`Context7 API Key : ${prefs.mcp?.context7ApiKey ? "configurée" : "absente"}`,
			].join("\n");

			if (ctx.hasUI) {
				ctx.ui.notify(exists ? "Préférences rechargées" : "Aucun fichier preferences.json trouvé", "info");
			}
			console.log(summary);
		},
	});
}
