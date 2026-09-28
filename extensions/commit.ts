import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Analyser les changements et demander à l’agent de créer des commits atomiques",
		handler: async (args, _ctx) => {
			const additionalInstructions = args.trim();
			await pi.sendUserMessage(
				[
					"Analyse les changements et crée des commits atomiques conformes à Conventional Commits, dans la langue utilisée par les autres commits du dépôt.",
					additionalInstructions,
				].filter(Boolean).join("\n\n"),
			);
		},
	});
}
