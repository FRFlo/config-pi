import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { moveCode, type MoveCodeArgs, type MoveCodeResult } from "./move-core";

const moveParameters = Type.Object({
  source_file: Type.String({
    description:
      "Source file inside the current project, for example 'src/old.ts'. Absolute paths are accepted only when still inside the project.",
  }),
  destination_file: Type.String({
    description:
      "Destination file inside the current project. It is created on apply if it does not exist.",
  }),
  start_line: Type.Integer({
    minimum: 1,
    description: "1-based inclusive source start line.",
  }),
  end_line: Type.Optional(Type.Integer({
    minimum: 1,
    description: "1-based inclusive source end line. Optional; defaults to start_line.",
  })),
  insert_mode: Type.Optional(StringEnum(["append", "prepend", "after_line", "before_line"] as const, {
    description:
      "Destination placement. Defaults to append. after_line/before_line use original-file line numbers with insert_line.",
  })),
  insert_line: Type.Optional(Type.Integer({
    minimum: 1,
    description:
      "1-based destination anchor line. Required for after_line/before_line; invalid for append/prepend.",
  })),
  adjust_indentation: Type.Optional(Type.Boolean({
    description:
      "Default false. When true, best-effort reindent by replacing common leading whitespace with destination indentation.",
  })),
  dry_run: Type.Optional(Type.Boolean({
    description:
      "Default true. Preview exact removal and insertion without writing. Set false only after reviewing the dry-run output.",
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "move",
    label: "Move",
    description:
      "Move a complete code block inside the current project. Dry-run first, then apply a best-effort rollback text relocation; imports and semantic refactors remain manual.",
    promptSnippet:
      "Move complete code blocks between files or locations without copy-then-delete",
    promptGuidelines: [
      "Use move when relocating existing complete code blocks; read source and destination files first.",
      "Call move with dry_run=true first, review the preview, then repeat with dry_run=false only if correct.",
      "After move applies, update imports, exports, references, formatting, and tests manually.",
    ],
    parameters: moveParameters,

    async execute(_toolCallId, params: MoveCodeArgs, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      onUpdate?.({ content: [{ type: "text", text: "Preparing move..." }], details: {} });

      const result = await moveCode(params, {
        worktree: ctx.cwd,
        mutateFiles: async (filePaths, run) => queueFileMutations(filePaths, run),
      });

      return {
        content: [{ type: "text", text: formatMoveResult(result) }],
        details: result,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("move "));
      text += theme.fg("accent", `${args.source_file ?? "?"}`);
      text += theme.fg("muted", " → ");
      text += theme.fg("accent", `${args.destination_file ?? "?"}`);
      if (args.start_line) {
        text += theme.fg("dim", ` lines ${args.start_line}-${args.end_line ?? args.start_line}`);
      }
      if (args.dry_run !== false) text += theme.fg("warning", " dry-run");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Preparing move..."), 0, 0);

      const details = result.details as MoveCodeResult | undefined;
      if (!details) return new Text(theme.fg("dim", "No move details"), 0, 0);

      let text = details.dry_run
        ? theme.fg("warning", "DRY RUN — no files changed")
        : theme.fg("success", "Move applied");
      text += theme.fg("dim", `\n${details.source_file} → ${details.destination_file}`);
      text += theme.fg("dim", `\nremoved lines ${details.removed_lines}; inserted at ${details.inserted_at}`);

      if (details.warnings.length > 0) {
        text += `\n${theme.fg("warning", details.warnings.join(" "))}`;
      }

      if (expanded) {
        text += `\n\n${theme.fg("muted", "--- removed_text ---")}`;
        text += `\n${theme.fg("dim", details.preview.removed_text)}`;
        text += `\n${theme.fg("muted", "--- inserted_text ---")}`;
        text += `\n${theme.fg("dim", details.preview.inserted_text)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}

async function queueFileMutations<T>(filePaths: string[], run: () => Promise<T>): Promise<T> {
  const uniquePaths = [...new Set(filePaths)].sort();

  const queueNext = (index: number): Promise<T> => {
    const filePath = uniquePaths[index];
    if (!filePath) return run();
    return withFileMutationQueue(filePath, () => queueNext(index + 1));
  };

  return queueNext(0);
}

function formatMoveResult(result: MoveCodeResult): string {
  const message = result.dry_run
    ? "DRY RUN ONLY — no files changed. Review preview.removed_text and preview.inserted_text, then re-run with dry_run=false to apply."
    : "Move applied with best-effort rollback protection. Review imports, exports, formatting, and tests manually.";

  return [
    message,
    `source_file: ${result.source_file}`,
    `destination_file: ${result.destination_file}`,
    `removed_lines: ${result.removed_lines}`,
    `inserted_at: ${result.inserted_at}`,
    `same_file: ${result.same_file}`,
    result.warnings.length > 0 ? `warnings: ${result.warnings.join(" ")}` : undefined,
    "",
    "--- removed_text ---",
    result.preview.removed_text,
    "--- inserted_text ---",
    result.preview.inserted_text,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
