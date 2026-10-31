---
name: move-tool
description: Relocate a complete code block between files or positions while preserving a reviewable diff.
---

# Move code blocks

Use this workflow when asked to relocate existing code. T3 Code has no separate `move` endpoint; use its native file editing tools instead of adding a duplicate tool.

1. Read the source and destination, and identify the exact 1-based inclusive line range or uniquely bounded block. Check that both paths are inside the project.
2. Prepare one patch that removes the block and inserts the same content at the destination. For a same-file move, compute the insertion point after accounting for the removed lines. Preserve line endings and indentation unless the user asks to adjust them.
3. Review the complete diff before applying it. Keep the removal and insertion together so the move cannot become a copy-only or delete-only change.
4. Update imports, exports, references, and formatting required by the relocation. Report any semantic changes that need a separate decision.

If the source range or destination is ambiguous, ask through T3 Code's native user input UI. A normal request to move code authorizes the edit; do not ask for a second confirmation after preparing the diff.
