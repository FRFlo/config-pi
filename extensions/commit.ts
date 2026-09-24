import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatResult(result: { stdout: string; stderr: string; code: number }): string {
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return output || `(aucune sortie, code ${result.code})`;
}

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Analyser les changements et demander à l’agent de créer des commits atomiques",
		handler: async (args, ctx) => {
			const request = args.trim();
			const commands = [
				["git", ["status", "--short"]],
				["git", ["diff", "--stat", "HEAD"]],
				["git", ["diff", "--cached", "--no-ext-diff", "--unified=3"]],
				["git", ["diff", "--no-ext-diff", "--unified=3"]],
				["git", ["log", "-8", "--format=%h %s"]],
			] as const;

			const executions = await Promise.allSettled(
				commands.map(async ([command, commandArgs]) => ({
					command: `${command} ${commandArgs.join(" ")}`,
					result: await pi.exec(command, [...commandArgs], { cwd: ctx.cwd }),
				})),
			);
			const results = executions.map((execution, index) => {
				const [command, commandArgs] = commands[index];
				if (execution.status === "fulfilled") return execution.value;
				return {
					command: `${command} ${commandArgs.join(" ")}`,
					result: { stdout: "", stderr: `Échec d’exécution : ${execution.reason}`, code: 1 },
				};
			});

			await pi.sendUserMessage(
				[
					"Prépare et crée les commits Git pour les changements actuels.",
					"Les commandes Git suivantes ont été exécutées nativement par Pi. Utilise leurs résultats pour analyser le dépôt, puis utilise tes outils normalement pour vérifier et committer.",
					"Regroupe les changements en commits atomiques et cohérents, respecte les conventions du dépôt, n’inclus pas les changements sans rapport et lance les vérifications pertinentes.",
					"Ne fais pas d’amend, de rebase ou de push sans demande explicite. Ne réinitialise et ne supprime jamais le travail existant.",
					request ? `Demande complémentaire : ${request}` : undefined,
					"",
					...results.map(({ command, result }) => `## ${command}\n\`\`\`\n${formatResult(result)}\n\`\`\``),
				].filter(Boolean).join("\n\n"),
			);
		},
	});
}
