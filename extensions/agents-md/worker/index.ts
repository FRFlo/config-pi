import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENTS_MD_SYSTEM } from "./prompt.js";
import { registerAgentsMdTool } from "./tool.js";

export default function agentsMdWorker(pi: ExtensionAPI): void {
	registerAgentsMdTool(pi);
	pi.on("before_agent_start", async () => ({ systemPrompt: AGENTS_MD_SYSTEM }));
	pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => ctx.shutdown());
}
