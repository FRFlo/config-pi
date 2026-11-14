// Prompt sections adapted from code-yeongyu/senpi (MIT).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildIntentGate } from "./intent-gate";
import { categorizeTools } from "./tool-categorization";
import { buildWorkingTaskSection } from "./working-task";
import { buildVerificationSection } from "./verification";
import { buildFileOperationsTuning } from "./file-operations";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const names = pi.getActiveTools();
    const model = ctx.model?.id?.toLowerCase() ?? "";
    const sections = [
      buildIntentGate({ tools: categorizeTools(names), surface: "app" }),
      buildWorkingTaskSection(),
      buildVerificationSection({ surface: "app" }),
    ];
    if (/^(gpt-|o[134])/.test(model)) sections.push(buildFileOperationsTuning({ toolNames: names }));
    return { systemPrompt: [event.systemPrompt, ...sections.filter(Boolean)].join("\n\n") };
  });
}
