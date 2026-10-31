---
name: ask-user-question
description: Ask for a missing decision through the current runtime's native user input interface.
---

# Ask the user

Use the input interface provided by the current runtime when a user choice or clarification materially affects the work.

- In T3 Code's Codex runtime, call `request_user_input_async`. In Pi, use the `ask_user_question` extension when it is available.
- The Pi extension detects T3 Code's Pi RPC mode and uses its native `ctx.ui.input` and `ctx.ui.select` dialogs instead of rendering a terminal-only prompt.
- Do not invoke both interfaces for the same question. Do not use the pending-request API to create a question; it only reads or answers requests already created by T3 Code.
- Ask concise, self-contained questions. Offer a few short options when useful, put the recommended option first, and leave free-text available.
- Continue work that does not depend on the answer. Pause only the dependent work.
