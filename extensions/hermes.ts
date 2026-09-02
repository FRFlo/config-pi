import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface HermesConfig {
	enabled?: boolean;
	baseUrl?: string;
	endpoint?: string;
	apiKey?: string;
	sessionId?: string;
	timeoutSeconds?: number;
	model?: string;
}

export function loadHermesConfig(): HermesConfig {
	const config: HermesConfig = {
		enabled: true,
		endpoint: process.env.HERMES_ENDPOINT || process.env.HERMES_BASE_URL || "https://your-hermes-url.example.com",
		baseUrl: process.env.HERMES_BASE_URL || process.env.HERMES_ENDPOINT || "https://your-hermes-url.example.com",
		apiKey: process.env.HERMES_API_KEY || "",
		timeoutSeconds: 45,
		model: "hermes-agent",
	};

	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		if (fs.existsSync(settingsPath)) {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed.hermes && typeof parsed.hermes === "object") {
				Object.assign(config, parsed.hermes);
			}
		}
	} catch (_err) {
		// Ignore parse errors, use defaults/env
	}

	if (config.endpoint && !config.baseUrl) {
		config.baseUrl = config.endpoint;
	}

	return config;
}

export function getHermesSessionId(config: HermesConfig): string {
	if (config.sessionId?.trim()) {
		return config.sessionId.trim();
	}
	if (config.apiKey?.trim()) {
		const hash = createHash("sha256").update(config.apiKey.trim()).digest("hex");
		return `pi-client-${hash.slice(0, 8)}`;
	}
	return "pi-client-default";
}

export async function sendHermesMessage(
	message: string,
	options: {
		systemPrompt?: string;
		signal?: AbortSignal;
		config?: HermesConfig;
	} = {},
): Promise<{ ok: boolean; response?: string; error?: string }> {
	const config = options.config || loadHermesConfig();
	const rawBase = config.endpoint || config.baseUrl;
	if (!rawBase) {
		return { ok: false, error: "Hermes endpoint/baseUrl is not configured" };
	}

	const sessionId = getHermesSessionId(config);
	const cleanBase = rawBase.replace(/\/+$/, "");
	const url = cleanBase.endsWith("/v1")
		? `${cleanBase}/chat/completions`
		: `${cleanBase}/v1/chat/completions`;

	const messages: Array<{ role: string; content: string }> = [];
	if (options.systemPrompt) {
		messages.push({ role: "system", content: options.systemPrompt });
	}
	messages.push({ role: "user", content: message });

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Hermes-Session-Id": sessionId,
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: config.model || "hermes-agent",
				user: sessionId,
				messages,
			}),
			signal: options.signal,
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			return {
				ok: false,
				error: `Hermes HTTP ${res.status}: ${errText || res.statusText}`,
			};
		}

		const data: any = await res.json();
		const replyContent =
			data.choices?.[0]?.message?.content ||
			data.choices?.[0]?.text ||
			(typeof data === "string" ? data : JSON.stringify(data));

		return { ok: true, response: replyContent };
	} catch (err: any) {
		if (err.name === "AbortError" || options.signal?.aborted) {
			return { ok: false, error: "Request aborted" };
		}
		return { ok: false, error: err.message || String(err) };
	}
}

export async function askHermesQuestion(
	params: {
		question: string;
		details?: string;
		options?: Array<{ label: string; value?: string; description?: string }>;
		multiSelect?: boolean;
	},
	signal?: AbortSignal,
	config?: HermesConfig,
): Promise<{ ok: boolean; rawAnswer?: string; matchedOptionIndex?: number; error?: string }> {
	const cfg = config || loadHermesConfig();

	let prompt = `[Question de Pi Agent pour Flo]\nQuestion: ${params.question}\n`;
	if (params.details) {
		prompt += `Détails: ${params.details}\n`;
	}

	const options = params.options || [];
	if (options.length > 0) {
		prompt += "\nOptions disponibles :\n";
		options.forEach((opt, idx) => {
			prompt += `${idx + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}\n`;
		});
		prompt += `\nFlo est actuellement absent du terminal. Pose-lui la question sur Discord (ou le canal actif) et retourne directement son choix/sa réponse.\n`;
	} else {
		prompt += `\nFlo est actuellement absent du terminal. Pose-lui la question sur Discord (ou le canal actif) et retourne sa réponse textuelle.\n`;
	}

	const systemPrompt =
		"Tu es Hermes Agent. Pi Agent (l'assistant de développement local de Flo) a besoin d'une décision de Flo pour continuer son travail. " +
		"Transmets cette question à Flo sur Discord, attends sa réponse, et retourne fidèlement sa décision/réponse finale.";

	const res = await sendHermesMessage(prompt, {
		systemPrompt,
		signal,
		config: cfg,
	});

	if (!res.ok || !res.response) {
		return { ok: false, error: res.error || "No response from Hermes" };
	}

	const rawAnswer = res.response.trim();

	// Check if rawAnswer matches any option number or label
	if (options.length > 0) {
		const numMatch = rawAnswer.match(/^(\d+)\b/);
		if (numMatch) {
			const idx = Number.parseInt(numMatch[1], 10) - 1;
			if (idx >= 0 && idx < options.length) {
				return { ok: true, rawAnswer, matchedOptionIndex: idx };
			}
		}

		const lower = rawAnswer.toLowerCase();
		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			if (
				lower.includes(opt.label.toLowerCase()) ||
				(opt.value && lower.includes(opt.value.toLowerCase()))
			) {
				return { ok: true, rawAnswer, matchedOptionIndex: i };
			}
		}
	}

	return { ok: true, rawAnswer };
}

const SendHermesMessageParams = Type.Object({
	message: Type.String({
		description: "The notification or message to send to Flo via Hermes Agent.",
	}),
	title: Type.Optional(
		Type.String({
			description: "Optional subject/title or category for the notification.",
		}),
	),
});

export default function hermesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "send_hermes_message",
		label: "send_hermes_message",
		description:
			"Send a message, report, or notification to Flo via Hermes Agent (which routes to Discord or active platforms).",
		promptSnippet: "Send an informational notification or status report via Hermes Agent.",
		promptGuidelines: [
			"Use this tool to inform the user about task completions, critical alerts, or background progress.",
			"Do not use this for asking blocking questions; use ask_user_question for questions.",
		],
		parameters: SendHermesMessageParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const fullMessage = params.title
				? `**[${params.title}]**\n${params.message}`
				: params.message;

			const result = await sendHermesMessage(fullMessage, { signal });

			if (!result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Échec de l'envoi via Hermes : ${result.error}`,
						},
					],
					details: { status: "error", error: result.error },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Message transmis à Hermes Agent avec succès.\nRéponse : ${result.response || "Délivré"}`,
					},
				],
				details: { status: "sent", response: result.response },
			};
		},
	});
}
