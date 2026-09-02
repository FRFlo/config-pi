import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface DiscordBridgeConfig {
	enabled?: boolean;
	endpoint?: string;
	apiKey?: string;
	timeoutSeconds?: number;
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
	question: string;
	details?: string;
	context?: string;
	recentMessages?: RecentTurnMessage[];
	options?: OptionItem[];
	multiSelect?: boolean;
	timeoutSeconds?: number;
}

export interface AnswerItem {
	type: "option" | "other" | "text";
	label: string;
	value: string;
	index?: number;
}

export interface DiscordQuestionResponse {
	ok: boolean;
	status: "answered" | "cancelled" | "retry" | "timeout";
	answers: AnswerItem[];
	error?: string;
	message?: string;
}

export function loadDiscordBridgeConfig(): DiscordBridgeConfig {
	const config: DiscordBridgeConfig = {
		enabled: true,
		endpoint: process.env.PI_BRIDGE_ENDPOINT || "https://your-bridge-url.example.com",
		apiKey: process.env.PI_BRIDGE_API_KEY || "",
		timeoutSeconds: 45,
		channelId: "your-discord-channel-id",
	};

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

export async function sendDiscordMessage(
	message: string,
	options: {
		title?: string;
		signal?: AbortSignal;
		config?: DiscordBridgeConfig;
	} = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
	const config = options.config || loadDiscordBridgeConfig();
	if (!config.endpoint) {
		return { ok: false, error: "L'endpoint pi-bridge n'est pas configuré" };
	}

	const cleanBase = config.endpoint.replace(/\/+$/, "");
	const url = `${cleanBase}/api/notify`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				message,
				title: options.title,
				channelId: config.channelId,
			}),
			signal: options.signal,
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			return {
				ok: false,
				error: `HTTP ${res.status}: ${errText || res.statusText}`,
			};
		}

		const data: any = await res.json();
		return { ok: true, messageId: data.messageId };
	} catch (err: any) {
		if (err.name === "AbortError" || options.signal?.aborted) {
			return { ok: false, error: "Requête annulée" };
		}
		return { ok: false, error: err.message || String(err) };
	}
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
				question: params.question,
				details: params.details,
				context: params.context,
				recentMessages: params.recentMessages,
				options: params.options,
				multiSelect: params.multiSelect,
				timeoutSeconds: params.timeoutSeconds || 300,
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

const SendDiscordMessageParams = Type.Object({
	message: Type.String({
		description: "The notification or message to send to the user on Discord (supports full Discord Markdown: bold, italic, codeblocks, quotes).",
	}),
	title: Type.Optional(
		Type.String({
			description: "Optional subject/title or category for the notification.",
		}),
	),
});

export default function discordBridgeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "send_discord_message",
		label: "send_discord_message",
		description:
			"Send a message, report, or notification directly to the user on Discord with full Discord Markdown support.",
		promptSnippet: "Send an informational notification or status report to Flo on Discord.",
		promptGuidelines: [
			"Use this tool to inform the user about task completions, critical alerts, or background progress on Discord.",
			"Supports full Discord Markdown formatting (bold, italics, code blocks, lists, quotes).",
			"Do not use this for asking blocking interactive questions; use ask_user_question for questions.",
		],
		parameters: SendDiscordMessageParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const result = await sendDiscordMessage(params.message, {
				title: params.title,
				signal,
			});

			if (!result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Échec de l'envoi sur Discord : ${result.error}`,
						},
					],
					details: { status: "error", error: result.error },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Message transmis sur Discord avec succès.",
					},
				],
				details: { status: "sent", messageId: result.messageId },
			};
		},
	});
}
