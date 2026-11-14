import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyFileWrites, moveParameters, prepareMove, queueFileMutations, type MoveCodeArgs } from "./move-tool";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "copy",
    label: "Copy",
    description: "Copy selected lines to a location in a project file, preserving the source. Preview by default; set dry_run=false to apply.",
    parameters: Type.Object({ ...moveParameters.properties, dry_run: Type.Optional(Type.Boolean({ description: "Default true. Preview insertion without writing; set false to apply." })) }),
    async execute(_toolCallId, params: MoveCodeArgs, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      let prepared = await prepareMove(params, { worktree: ctx.cwd, copy: true });
      const dryRun = params.dry_run ?? true;
      if (!dryRun) {
        await queueFileMutations([prepared.sourcePath, prepared.destinationPath], async () => {
          prepared = await prepareMove(params, { worktree: ctx.cwd, copy: true });
          await applyFileWrites([{ filePath: prepared.destinationPath, content: prepared.newDestinationText }]);
        });
      }
      const details = {
        dry_run: dryRun,
        source_file: prepared.sourcePath,
        destination_file: prepared.destinationPath,
        copied_lines: prepared.selected.label,
        inserted_at: prepared.insertion.label,
        same_file: prepared.sameFile,
        inserted_text: prepared.insertedText,
        warnings: prepared.warnings,
      };
      return {
        content: [{ type: "text", text: `${dryRun ? "DRY RUN — no files changed" : "Copy applied"}\nsource_file: ${details.source_file}\ndestination_file: ${details.destination_file}\ncopied_lines: ${details.copied_lines}\ninserted_at: ${details.inserted_at}\n\n--- inserted_text ---\n${details.inserted_text}` }],
        details,
      };
    },
  });
}
