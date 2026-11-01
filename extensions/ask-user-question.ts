import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

type AskAnswer =
	| { type: "text"; label: string; value: string }
	| { type: "option"; label: string; value: string; index: number };

type AskMode = "text" | "single-select";

interface AskResultDetails {
	status: "answered" | "cancelled" | "unavailable";
	question: string;
	context?: string;
	mode: AskMode;
	answers: AskAnswer[];
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label shown as a choice." }),
	value: Type.Optional(Type.String({ description: "Value returned for this choice; defaults to the label." })),
	description: Type.Optional(Type.String({ description: "Optional explanation appended to the choice label." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({ description: "The one question to ask the user." }),
	details: Type.Optional(Type.String({ description: "Optional detail to include with the question." })),
	context: Type.Optional(Type.String({ description: "Brief context to help the user answer." })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: "Optional choices. Omit for a free-form text answer. Only one choice can be selected.",
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

function makeDialogTitle(question: string, details?: string, context?: string): string {
	return [question, details, context ? `Context: ${context}` : undefined].filter(Boolean).join("\n\n");
}

function makeResult(
	status: AskResultDetails["status"],
	question: string,
	context: string | undefined,
	mode: AskMode,
	answers: AskAnswer[] = [],
	message?: string,
) {
	const text =
		status === "answered"
			? answers
					.map((answer) => {
						if (answer.type === "option") return `${answer.index}. ${answer.label}`;
						return answer.label;
					})
					.join("\n")
			: message || (status === "cancelled" ? "User cancelled the question." : "Question UI is unavailable.");
	return {
		content: [{ type: "text" as const, text }],
		details: { status, question, context, mode, answers, message } satisfies AskResultDetails,
	};
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user one question through T3 Code's native RPC user-input dialog. In delegated threads, T3 Code routes the pending question to the parent agent. Use choices for a single selection; omit choices for free-form input.",
		promptSnippet:
			"Ask through T3 Code's native RPC dialog; delegated questions are routed to the parent automatically.",
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.context?.trim() || undefined;
			const mode: AskMode = options.length > 0 ? "single-select" : "text";

			if (signal?.aborted) {
				return makeResult("cancelled", params.question, context, mode);
			}
			if (!ctx.hasUI || ctx.mode !== "rpc") {
				return makeResult(
					"unavailable",
					params.question,
					context,
					mode,
					[],
					"ask_user_question requires T3 Code's Pi RPC UI.",
				);
			}

			const title = makeDialogTitle(params.question, params.details?.trim(), context);
			if (mode === "text") {
				const value = await ctx.ui.input(title, "", { signal });
				const answer = value?.trim();
				if (!answer) return makeResult("cancelled", params.question, context, mode);
				return makeResult("answered", params.question, context, mode, [
					{ type: "text", label: answer, value: answer },
				]);
			}

			const choiceLabels = options.map((option, index) => {
				const description = option.description ? ` — ${option.description}` : "";
				return `${index + 1}. ${option.label}${description}`;
			});
			const selected = await ctx.ui.select(title, choiceLabels, { signal });
			if (selected === undefined) return makeResult("cancelled", params.question, context, mode);

			const index = choiceLabels.indexOf(selected);
			const option = index >= 0 ? options[index] : undefined;
			if (!option) return makeResult("cancelled", params.question, context, mode);
			return makeResult("answered", params.question, context, mode, [
				{ type: "option", label: option.label, value: option.value, index: index + 1 },
			]);
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (options.length > 0) {
				text += `\n${theme.fg("dim", "choices: ")}${theme.fg("text", options.map((option) => option.label).join(", "))}`;
			}
			if (args.details) text += `\n${theme.fg("dim", "details: ")}${theme.fg("muted", args.details)}`;
			if (args.context) text += `\n${theme.fg("dim", "context: ")}${theme.fg("muted", args.context)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResultDetails | undefined;
			if (!details) return new Text(result.content?.[0]?.text || "", 0, 0);
			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Question cancelled"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("error", details.message || "T3 Code RPC UI unavailable"), 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("text", result.content?.[0]?.text || ""), 0, 0);
		},
	});
}
