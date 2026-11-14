// History indexer adapted from code-yeongyu/senpi (MIT).
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { indexSessions } from "./indexer";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("history", {
    description: "Search prompts across Pi sessions",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const query = args.trim() || await ctx.ui.input("Search prompt history");
      if (!query?.trim()) return;
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const entries = (await indexSessions(join(getAgentDir(), "sessions")))
        .filter((entry) => words.every((word) => entry.text.toLowerCase().includes(word)))
        .slice(0, 100);
      if (!entries.length) { ctx.ui.notify("No matching prompts", "info"); return; }
      const labels = entries.map((entry, index) => `${index + 1}. ${entry.text.replace(/\s+/g, " ").slice(0, 160)}`);
      const selected = await ctx.ui.select("Prompt history", labels);
      const index = labels.indexOf(selected ?? "");
      if (index >= 0) ctx.ui.setEditorText(entries[index].text);
    },
  });
}
