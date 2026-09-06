import { Text, truncateToVisualLines } from "../utils/visual-truncate.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";
import type { MonitorInput, monitorSchema } from "./monitor.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type MonitorToolDefinition = ToolDefinition<typeof monitorSchema, BashOutputDetails>;
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];

const OUTPUT_PREVIEW_LINES = 8;

class BashOutputResultComponent {
	#text = "";
	#isPartial = false;
	#expanded = false;

	setResult(result: AgentToolResult<BashOutputDetails>, options: RenderResultOptions): void {
		const block = result.content.find((content) => content.type === "text");
		this.#text = block?.type === "text" ? block.text : "";
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (!this.#isPartial || this.#expanded) {
			return this.#text.split("\n").map((line) => truncateToWidth(line, renderWidth, ""));
		}
		return truncateToVisualLines(this.#text, OUTPUT_PREVIEW_LINES, renderWidth).visualLines.map((line) =>
			truncateToWidth(line.trimEnd(), renderWidth, ""),
		);
	}

	invalidate(): void {}
}

export function renderBashOutputCall(
	args: BashOutputInput,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[1],
): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`bash_output ${args.bash_id}`)), 0, 0);
}

export function renderMonitorCall(
	args: MonitorInput,
	theme: Parameters<NonNullable<MonitorToolDefinition["renderCall"]>>[1],
): Text {
	const label =
		args.action === "rearm"
			? `monitor rearm ${args.bash_id ?? ""}`.trimEnd()
			: `monitor ${args.description ?? args.command ?? ""}`.trimEnd();
	return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
}

export function renderBashOutputResult(
	result: AgentToolResult<BashOutputDetails>,
	options: RenderResultOptions,
	_theme: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[2],
	context: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[3],
): BashOutputResultComponent {
	const component =
		(context.lastComponent as BashOutputResultComponent | undefined) ?? new BashOutputResultComponent();
	component.setResult(result, options);
	return component;
}
