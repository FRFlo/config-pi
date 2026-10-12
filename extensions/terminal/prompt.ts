/** Contextual guidance emitted only while background terminal sessions are active. */
export function createTerminalPromptSection(sessionIds: readonly string[]): string | undefined {
	if (sessionIds.length === 0) return undefined;

	return `
## Active background terminal sessions

Sessions still running: ${sessionIds.join(", ")}.
Use \`bash_output\` or \`monitor\` to inspect progress, \`bash_input\` to interact, and
\`kill_bash\` when a process is no longer needed. Check these sessions before starting a
duplicate process. This section is refreshed at the start of each agent turn.
`;
}
