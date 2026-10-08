# Pi setup auto-updater

`auto-update.ts` checks `~/.pi/agent` when a Pi session starts. It runs
`git pull --ff-only` only when the setup repository has no local changes; if
the pull brings in commits, Pi reloads its extensions and resources automatically.
Local edits and untracked files are never stashed, reset, or overwritten.

Run `/update` in Pi to check and update manually. It uses the same clean-working-
tree check and reloads Pi only when new commits were pulled. Set `PI_AGENT_DIR`
to override the setup repository path.
