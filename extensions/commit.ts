import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Analyser les changements et demander à l’agent de créer des commits atomiques",
		handler: async (_args, _ctx) => {
			await pi.sendUserMessage(
				"Crée un commit conforme à Conventional Commits, dans la langue utilisée par les autres commits du dépôt.",
			);
		},
	});
}
