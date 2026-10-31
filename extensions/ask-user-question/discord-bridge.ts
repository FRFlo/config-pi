import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DiscordBridgeConfig {
	enabled?: boolean;
	endpoint?: string;
	apiKey?: string;
	channelId?: string;
}

export interface OptionItem {
	label: string;
	value?: string;
	description?: string;
}

export interface RecentTurnMessage {
	role: string;
	content: string;
}

export interface AskQuestionPayload {
	id?: string;
	question: string;
	details?: string;
	context?: string;
	recentMessages?: RecentTurnMessage[];
	options?: OptionItem[];
	multiSelect?: boolean;
}

export interface AnswerItem {
	type: "option" | "other" | "text";
	label: string;
	value: string;
	index?: number;
}

export interface DiscordQuestionResponse {
	ok: boolean;
	status: "answered" | "cancelled" | "retry";
	answers: AnswerItem[];
	error?: string;
	message?: string;
}

export function loadDiscordBridgeConfig(): DiscordBridgeConfig {
	const config: DiscordBridgeConfig = {
		enabled: true,
		endpoint: process.env.PI_BRIDGE_ENDPOINT || "",
		apiKey: process.env.PI_BRIDGE_API_KEY || "",
		channelId: process.env.PI_BRIDGE_CHANNEL_ID || "",
	};

	// 1. Lire d'abord les préférences locales (preferences.json)
	try {
		const prefsPath = path.join(os.homedir(), ".pi", "agent", "preferences.json");
		if (fs.existsSync(prefsPath)) {
			const raw = fs.readFileSync(prefsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed.discordBridge && typeof parsed.discordBridge === "object") {
				Object.assign(config, parsed.discordBridge);
			}
		}
	} catch (_err) {
		// Ignore parse error
	}

	// 2. Repli éventuel sur settings.json
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		if (fs.existsSync(settingsPath)) {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed.discordBridge && typeof parsed.discordBridge === "object") {
				Object.assign(config, parsed.discordBridge);
			}
		}
	} catch (_err) {
		// Ignore parse error, use defaults/env
	}

	return config;
}

export async function askDiscordQuestion(
	params: AskQuestionPayload,
	signal?: AbortSignal,
	config?: DiscordBridgeConfig,
): Promise<DiscordQuestionResponse> {
	const cfg = config || loadDiscordBridgeConfig();
	if (!cfg.endpoint) {
		return {
			ok: false,
			status: "cancelled",
			answers: [],
			error: "L'endpoint pi-bridge n'est pas configuré",
		};
	}

	const cleanBase = cfg.endpoint.replace(/\/+$/, "");
	const url = `${cleanBase}/api/ask`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (cfg.apiKey) {
		headers.Authorization = `Bearer ${cfg.apiKey}`;
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				id: params.id,
				question: params.question,
				details: params.details,
				context: params.context,
				recentMessages: params.recentMessages,
				options: params.options,
				multiSelect: params.multiSelect,
				channelId: cfg.channelId,
			}),
			signal,
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			return {
				ok: false,
				status: "cancelled",
				answers: [],
				error: `HTTP ${res.status}: ${errText || res.statusText}`,
			};
		}

		const data: any = await res.json();
		return {
			ok: true,
			status: data.status || "answered",
			answers: data.answers || [],
			message: data.message,
		};
	} catch (err: any) {
		if (err.name === "AbortError" || signal?.aborted) {
			return {
				ok: false,
				status: "cancelled",
				answers: [],
				error: "Requête annulée",
			};
		}
		return {
			ok: false,
			status: "cancelled",
			answers: [],
			error: err.message || String(err),
		};
	}
}

export async function resolveDiscordQuestion(
	questionId: string,
	statusMessage?: string,
	isCancelled = false,
	config?: DiscordBridgeConfig,
): Promise<boolean> {
	const cfg = config || loadDiscordBridgeConfig();
	if (!cfg.endpoint) return false;

	const cleanBase = cfg.endpoint.replace(/\/+$/, "");
	const url = `${cleanBase}/api/ask/${encodeURIComponent(questionId)}/resolve`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (cfg.apiKey) {
		headers.Authorization = `Bearer ${cfg.apiKey}`;
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				statusMessage,
				status: isCancelled ? "cancelled" : "answered",
				isCancelled,
			}),
		});
		return res.ok;
	} catch {
		return false;
	}
}
