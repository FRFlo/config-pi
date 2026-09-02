import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type AnswerItem,
	askDiscordQuestion,
	loadDiscordBridgeConfig,
	resolveDiscordQuestion,
} from "./discord-bridge";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	context: Type.Optional(
		Type.String({
			description: "Optional summary of relevant task context or code snippet to help the user decide.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function extractRecentConversation(sessionManager?: any, maxCount = 6): Array<{ role: string; content: string }> {
	if (!sessionManager) return [];
	try {
		const branch = (typeof sessionManager.getBranch === "function"
			? sessionManager.getBranch()
			: typeof sessionManager.getEntries === "function"
			? sessionManager.getEntries()
			: []) as Array<any>;

		const messages: Array<{ role: string; content: string }> = [];

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message) {
				const msg = entry.message;
				if (msg.role === "user" || msg.role === "assistant") {
					let text = "";
					if (typeof msg.content === "string") {
						text = msg.content;
					} else if (Array.isArray(msg.content)) {
						text = msg.content
							.filter((c: any) => c.type === "text" && c.text)
							.map((c: any) => c.text)
							.join("\n");
					}
					text = text.trim();
					if (text) {
						messages.unshift({ role: msg.role, content: text });
					}
				}
			}
			if (messages.length >= maxCount) break;
		}
		return messages;
	} catch {
		return [];
	}
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = " ") {
	for (const line of wrapTextWithAnsi(text, Math.max(1, width - indent.length))) {
		lines.push(`${indent}${line}`);
	}
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
): AskUserQuestionResultDetails {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
	};
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string, message?: string) {
	const cancelMsg = message || "User cancelled the question prompt";
	return {
		content: [{ type: "text" as const, text: cancelMsg }],
		details: buildStructuredResult("cancelled", question, mode, [], context, cancelMsg),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function formatAnswersForContent(answers: AskAnswer[]): string {
	if (answers.length === 0) return "No answer provided";
	if (answers.length === 1) {
		const a = answers[0];
		if (a.type === "option") return `${a.index}. ${a.label}`;
		if (a.type === "other") return `Other: ${a.label}`;
		return a.label;
	}

	return answers
		.map((a) => {
			if (a.type === "option") return `- ${a.index}. ${a.label}`;
			if (a.type === "other") return `- Other: ${a.label}`;
			return `- ${a.label}`;
		})
		.join("\n");
}

function buildResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
) {
	return {
		content: [{ type: "text" as const, text: formatAnswersForContent(answers) }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

async function askTextMode(
	ctx: any,
	question: string,
	details: string | undefined,
	context: string | undefined,
): Promise<{ answers: AskAnswer[] | null; retry?: boolean }> {
	const discordConfig = loadDiscordBridgeConfig();
	const timeoutSeconds = discordConfig.enabled !== false ? discordConfig.timeoutSeconds || 45 : 0;

	return ctx.ui.custom<{ answers: AskAnswer[] | null; retry?: boolean }>((tui: any, theme: any, _kb: any, done: (result: { answers: AskAnswer[] | null; retry?: boolean }) => void) => {
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let finished = false;
		let delegationStatus: string | undefined;
		let timer: any = null;
		const questionId = Math.random().toString(36).slice(2, 10);
		let isDelegating = false;
		const abortCtrl = new AbortController();
		const editor = new Editor(tui, createEditorTheme(theme));

		function safeDone(result: { answers: AskAnswer[] | null; retry?: boolean }) {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			abortCtrl.abort();
			if (isDelegating) {
				if (result.answers) {
					resolveDiscordQuestion(questionId, "✅ Répondu directement depuis le terminal local", false, discordConfig).catch(() => {});
				} else if (!result.retry) {
					resolveDiscordQuestion(questionId, "❌ Question annulée depuis le terminal local", true, discordConfig).catch(() => {});
				}
			}
			done(result);
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				safeDone({ answers: null });
				return;
			}
			safeDone({ answers: [{ type: "text", label: trimmed, value: trimmed }] });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		if (timeoutSeconds >= 0 && discordConfig.endpoint) {
			const startDelegation = () => {
				if (finished) return;
				isDelegating = true;
				delegationStatus = "Question déléguée à Discord via pi-bridge...";
				refresh();

				const recentMessages = extractRecentConversation(ctx.sessionManager, 6);
				askDiscordQuestion(
					{
						id: questionId,
						question,
						details,
						context,
						recentMessages,
						timeoutSeconds: 300,
					},
					abortCtrl.signal,
					discordConfig,
				)
					.then((res) => {
						if (abortCtrl.signal.aborted || finished) return;
						if (res.status === "answered" && res.answers.length > 0) {
							const mappedAnswers: AskAnswer[] = res.answers.map((a) => ({
								type: "text",
								label: a.label,
								value: a.value,
							}));
							safeDone({ answers: mappedAnswers });
						} else if (res.status === "retry") {
							safeDone({ answers: null, retry: true });
						} else if (res.status === "cancelled") {
							safeDone({ answers: null });
						} else {
							delegationStatus = `Erreur Discord: ${res.error || "Pas de réponse"}`;
							refresh();
						}
					})
					.catch((err) => {
						if (!abortCtrl.signal.aborted && !finished) {
							delegationStatus = `Erreur Discord: ${err.message || String(err)}`;
							refresh();
						}
					});
			};

			if (timeoutSeconds === 0) {
				startDelegation();
			} else {
				timer = setTimeout(startDelegation, timeoutSeconds * 1000);
			}
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				safeDone({ answers: null });
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (details) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${details}`), width);
			}
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("dim", ` Contexte: ${context}`), width);
			}
			lines.push("");

			if (delegationStatus) {
				add(theme.fg("warning", ` 🤖 [Discord Relay] ${delegationStatus}`));
				lines.push("");
			} else if (timeoutSeconds > 0) {
				add(theme.fg("dim", ` (Délégation Discord si inactif pendant ${timeoutSeconds}s)`));
				lines.push("");
			}

			add(theme.fg("muted", " Saisissez votre réponse :"));
			for (const line of editor.render(Math.max(1, width - 2))) {
				add(` ${line}`);
			}
			lines.push("");
			add(theme.fg("dim", " Entrée pour valider • Échap pour annuler"));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

async function askSingleChoice(
	ctx: any,
	question: string,
	details: string | undefined,
	context: string | undefined,
	options: AskOption[],
): Promise<{ answers: AskAnswer[] | null; retry?: boolean }> {
	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({
			...option,
			id: `option:${index}`,
			index: index + 1,
		})),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	const discordConfig = loadDiscordBridgeConfig();
	const timeoutSeconds = discordConfig.enabled !== false ? (typeof discordConfig.timeoutSeconds === "number" ? discordConfig.timeoutSeconds : 45) : -1;

	return ctx.ui.custom<{ answers: AskAnswer[] | null; retry?: boolean }>((tui: any, theme: any, _kb: any, done: (result: { answers: AskAnswer[] | null; retry?: boolean }) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let finished = false;
		let delegationStatus: string | undefined;
		let timer: any = null;
		const questionId = Math.random().toString(36).slice(2, 10);
		let isDelegating = false;
		const abortCtrl = new AbortController();
		const editor = new Editor(tui, createEditorTheme(theme));

		function safeDone(result: { answers: AskAnswer[] | null; retry?: boolean }) {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			abortCtrl.abort();
			if (isDelegating) {
				if (result.answers) {
					resolveDiscordQuestion(questionId, "✅ Répondu directement depuis le terminal local", false, discordConfig).catch(() => {});
				} else if (!result.retry) {
					resolveDiscordQuestion(questionId, "❌ Question annulée depuis le terminal local", true, discordConfig).catch(() => {});
				}
			}
			done(result);
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			safeDone({ answers: [{ type: "other", label: trimmed, value: trimmed }] });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		if (timeoutSeconds >= 0 && discordConfig.endpoint) {
			const startDelegation = () => {
				if (finished) return;
				isDelegating = true;
				delegationStatus = "Question déléguée à Discord via pi-bridge...";
				refresh();

				const recentMessages = extractRecentConversation(ctx.sessionManager, 6);
				askDiscordQuestion(
					{
						id: questionId,
						question,
						details,
						context,
						recentMessages,
						options,
						multiSelect: false,
						timeoutSeconds: 300,
					},
					abortCtrl.signal,
					discordConfig,
				)
					.then((res) => {
						if (abortCtrl.signal.aborted || finished) return;
						if (res.status === "answered" && res.answers.length > 0) {
							const ans = res.answers[0];
							if (ans.type === "option" && ans.index) {
								const opt = options[ans.index - 1] || { label: ans.label, value: ans.value };
								safeDone({
									answers: [
										{
											type: "option",
											label: opt.label,
											value: opt.value,
											index: ans.index,
										},
									],
								});
							} else {
								safeDone({
									answers: [
										{
											type: "other",
											label: ans.label,
											value: ans.value,
										},
									],
								});
							}
						} else if (res.status === "retry") {
							safeDone({ answers: null, retry: true });
						} else if (res.status === "cancelled") {
							safeDone({ answers: null });
						} else {
							delegationStatus = `Erreur Discord: ${res.error || "Pas de réponse"}`;
							refresh();
						}
					})
					.catch((err) => {
						if (!abortCtrl.signal.aborted && !finished) {
							delegationStatus = `Erreur Discord: ${err.message || String(err)}`;
							refresh();
						}
					});
			};

			if (timeoutSeconds === 0) {
				startDelegation();
			} else {
				timer = setTimeout(startDelegation, timeoutSeconds * 1000);
			}
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				safeDone({
					answers: [
						{
							type: "option",
							label: selected.label,
							value: selected.value,
							index: selected.index!,
						},
					],
				});
				return;
			}
			if (matchesKey(data, Key.escape)) {
				safeDone({ answers: null });
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (details) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${details}`), width);
			}
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("dim", ` Contexte: ${context}`), width);
			}
			lines.push("");

			if (delegationStatus) {
				add(theme.fg("warning", ` 🤖 [Discord Relay] ${delegationStatus}`));
				lines.push("");
			} else if (timeoutSeconds > 0) {
				add(theme.fg("dim", ` (Délégation Discord si inactif pendant ${timeoutSeconds}s)`));
				lines.push("");
			}

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const isFocused = i === optionIndex;
				const isOther = Boolean(option.isOther);
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";
				const label = isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = isFocused ? theme.bold(theme.fg("accent", label)) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => {
		if (a.type === "option" && b.type === "option") return a.index - b.index;
		if (a.type === "option") return -1;
		if (b.type === "option") return 1;
		return 0;
	});
}

async function askMultiChoice(
	ctx: any,
	question: string,
	details: string | undefined,
	context: string | undefined,
	options: AskOption[],
): Promise<{ answers: AskAnswer[] | null; retry?: boolean }> {
	const otherLabel = getOtherLabel(options);
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const submitItem: DisplayOption = {
		id: "submit",
		label: "Submit selection",
		value: "__submit__",
		isSubmit: true,
	};
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		submitItem,
	];

	const discordConfig = loadDiscordBridgeConfig();
	const timeoutSeconds = discordConfig.enabled !== false ? (typeof discordConfig.timeoutSeconds === "number" ? discordConfig.timeoutSeconds : 45) : -1;

	return ctx.ui.custom<{ answers: AskAnswer[] | null; retry?: boolean }>((tui: any, theme: any, _kb: any, done: (result: { answers: AskAnswer[] | null; retry?: boolean }) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let finished = false;
		let delegationStatus: string | undefined;
		let timer: any = null;
		const questionId = Math.random().toString(36).slice(2, 10);
		let isDelegating = false;
		const abortCtrl = new AbortController();
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));

		function safeDone(result: { answers: AskAnswer[] | null; retry?: boolean }) {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			abortCtrl.abort();
			if (isDelegating) {
				if (result.answers) {
					resolveDiscordQuestion(questionId, "✅ Répondu directement depuis le terminal local", false, discordConfig).catch(() => {});
				} else if (!result.retry) {
					resolveDiscordQuestion(questionId, "❌ Question annulée depuis le terminal local", true, discordConfig).catch(() => {});
				}
			}
			done(result);
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		if (timeoutSeconds >= 0 && discordConfig.endpoint) {
			const startDelegation = () => {
				if (finished) return;
				isDelegating = true;
				delegationStatus = "Question déléguée à Discord via pi-bridge...";
				refresh();

				const recentMessages = extractRecentConversation(ctx.sessionManager, 6);
				askDiscordQuestion(
					{
						id: questionId,
						question,
						details,
						context,
						recentMessages,
						options,
						multiSelect: true,
						timeoutSeconds: 300,
					},
					abortCtrl.signal,
					discordConfig,
				)
					.then((res) => {
						if (abortCtrl.signal.aborted || finished) return;
						if (res.status === "answered" && res.answers.length > 0) {
							const mappedAnswers: AskAnswer[] = res.answers.map((ans) => {
								if (ans.type === "option" && ans.index) {
									const opt = options[ans.index - 1] || { label: ans.label, value: ans.value };
									return {
										type: "option",
										label: opt.label,
										value: opt.value,
										index: ans.index,
									};
								}
								return {
									type: "other",
									label: ans.label,
									value: ans.value,
								};
							});
							safeDone({ answers: sortAnswers(mappedAnswers) });
						} else if (res.status === "retry") {
							safeDone({ answers: null, retry: true });
						} else if (res.status === "cancelled") {
							safeDone({ answers: null });
						} else {
							delegationStatus = `Erreur Discord: ${res.error || "Pas de réponse"}`;
							refresh();
						}
					})
					.catch((err) => {
						if (!abortCtrl.signal.aborted && !finished) {
							delegationStatus = `Erreur Discord: ${err.message || String(err)}`;
							refresh();
						}
					});
			};

			if (timeoutSeconds === 0) {
				startDelegation();
			} else {
				timer = setTimeout(startDelegation, timeoutSeconds * 1000);
			}
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					if (selected.size > 0) {
						safeDone({ answers: sortAnswers(Array.from(selected.values())) });
					}
					return;
				}
				if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				safeDone({ answers: null });
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (details) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${details}`), width);
			}
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("dim", ` Contexte: ${context}`), width);
			}
			lines.push("");

			if (delegationStatus) {
				add(theme.fg("warning", ` 🤖 [Discord Relay] ${delegationStatus}`));
				lines.push("");
			} else if (timeoutSeconds > 0) {
				add(theme.fg("dim", ` (Délégation Discord si inactif pendant ${timeoutSeconds}s)`));
				lines.push("");
			}

			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i];
				const isFocused = i === optionIndex;

				if (item.isSubmit) {
					lines.push("");
					const prefix = isFocused ? theme.fg("accent", "> ") : "  ";
					const styled = isFocused ? theme.bold(theme.fg("accent", `[ ${item.label} ]`)) : theme.fg("dim", `[ ${item.label} ]`);
					add(`${prefix}${styled}`);
					continue;
				}

				const isOther = Boolean(item.isOther);
				const otherAnswer = selected.get("other");
				const checked = isOther ? Boolean(otherAnswer) : selected.has(item.id);
				const checkbox = checked ? "[x] " : "[ ] ";
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";
				const label = isOther
					? otherAnswer
						? `Other: ${otherAnswer.label}`
						: item.label
					: `${item.index}. ${item.label}`;
				const styled = isFocused
					? theme.fg("accent", `${checkbox}${label}`)
					: theme.fg(checked ? "success" : "text", `${checkbox}${label}`);
				add(`${prefix}${styled}`);
				if (item.description) {
					addWrapped(lines, theme.fg("muted", item.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("warning", " Select at least one answer before submitting."));
				}
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const details = params.details?.trim() || undefined;
			const context = params.context?.trim() || undefined;
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "ask_user_question requires interactive mode UI", context);
			}

			return withUILock(async () => {
				if (mode === "text") {
					const res = await askTextMode(ctx, params.question, details, context);
					if (res.retry) {
						return cancelledResult(params.question, mode, context, "Action interrompue pour forker / réessayer la session depuis Discord.");
					}
					if (!res.answers) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, res.answers);
				}

				if (mode === "single-select") {
					const res = await askSingleChoice(ctx, params.question, details, context, options);
					if (res.retry) {
						return cancelledResult(params.question, mode, context, "Action interrompue pour forker / réessayer la session depuis Discord.");
					}
					if (!res.answers) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, res.answers);
				}

				const res = await askMultiChoice(ctx, params.question, details, context, options);
				if (res.retry) {
					return cancelledResult(params.question, mode, context, "Action interrompue pour forker / réessayer la session depuis Discord.");
				}
				if (!res.answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, res.answers);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", "options: ")}${theme.fg("text", labels)}`;
			}
			if (args.details) {
				text += `\n${theme.fg("dim", "details: ")}${theme.fg("muted", args.details)}`;
			}
			if (args.context) {
				text += `\n${theme.fg("dim", "context: ")}${theme.fg("muted", args.context)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				return new Text(result.content?.[0]?.text || "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", `Cancelled: ${details.message || "No answer"}`), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("error", `Unavailable: ${details.message || "UI required"}`), 0, 0);
			}

			const answerSummary = formatAnswersForContent(details.answers);
			return new Text(theme.fg("success", "✓ ") + theme.fg("text", answerSummary), 0, 0);
		},
	});
}
