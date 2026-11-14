import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsMdCommands } from "./src/agents-md.js";

export default function agentsMdExtension(pi: ExtensionAPI): void {
	if (process.env.OM_WORKER === "agents-md") return;
	registerAgentsMdCommands(pi);
}
