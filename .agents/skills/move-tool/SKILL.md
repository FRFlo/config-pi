---
name: move-tool
description: Relocate a complete code block between files or positions while preserving a reviewable diff.
---

# Move code blocks

Use the `move` extension when it is available in Pi. In T3 Code's Codex runtime, use the native file-editing tools; do not add a second move endpoint.

1. Read the source and destination, and identify the exact 1-based inclusive line range or uniquely bounded block. Keep both paths inside the project.
2. Prepare the relocation as one patch. For a same-file move, account for removed lines when calculating the insertion point. Preserve line endings and indentation unless the user asks to adjust them.
3. Review the complete diff before applying it. Keep removal and insertion together so the change cannot become copy-only or delete-only.
4. Update imports, exports, references, and formatting required by the move. Report any semantic changes that need a separate decision.

If the source range or destination is ambiguous, ask through the current runtime's native user input interface. A clear request to move code authorizes the edit; do not ask for a second confirmation after preparing the diff.
