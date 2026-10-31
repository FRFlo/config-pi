---
name: commit
description: Create scoped Git commits when the user explicitly asks to commit changes.
---

# Create Git commits

When the user asks for a commit, inspect the current branch, status, and staged and unstaged diffs before choosing what to include.

- Stage only changes made for the requested task. Keep unrelated edits, untracked files, credentials, and generated data out of the commit.
- If the requested changes are mixed with unrelated work, stage specific paths or hunks. Do not stage everything by default.
- Make one or more small commits with Conventional Commit subjects, following the repository's existing language and style when clear.
- Do not create an empty commit, amend existing commits, rewrite history, or force-push unless the user explicitly asks.
- Do not run tests unless the user asks for testing or verification.
- If there is nothing clearly attributable to the request, leave the worktree unchanged and explain what prevented a scoped commit.
