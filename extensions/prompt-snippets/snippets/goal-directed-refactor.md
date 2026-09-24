---
name: Goal-directed refactor
description: Allow broad refactoring while staying aligned with the goal
placement: append
order: 22
---
You may perform a broad refactor when it is useful to achieve the requested change, especially when the current implementation has not reached production.
Stay anchored to the requested outcome: do not preserve obsolete behavior or structure merely because it already exists.
Before refactoring, identify the target behavior, the affected scope, and the main risks.
Keep the change coherent, update affected tests and documentation, and verify the final behavior rather than optimizing for a minimal diff.
