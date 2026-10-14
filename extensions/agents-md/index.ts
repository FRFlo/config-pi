import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../observational-memory/src/config.js";
import type { ConfiguredModel } from "../observational-memory/src/config.js";
import { registerAgentsMdCommands, updateAgentsMd } from "./src/agents-md.js";

export default function agentsMdExtension(pi: ExtensionAPI): void {
	if (process.env.OM_WORKER === "agents-md") return;
	registerAgentsMdCommands(pi);
	pi.events.on("observational-memory:consolidated", (data) => {
		if (!data || typeof data !== "object") return;
		const event = data as { projectRoot?: unknown; memoryRoot?: unknown; model?: unknown };
		if (typeof event.projectRoot !== "string" || typeof event.memoryRoot !== "string") return;
		const model = event.model && typeof event.model === "object"
			? (event.model as ConfiguredModel)
			: loadConfig(event.projectRoot).models.consolidator;
		void updateAgentsMd({ memoryRoot: event.memoryRoot, model }, event.projectRoot, {
			rebuild: false,
		}).catch((error) => console.error(`[agents-md] automatic update failed: ${String(error)}`));
	});
}
