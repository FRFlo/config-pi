---
name: ask-user-question
description: Ask for a missing decision or clarification through T3 Code's native user input UI.
---

# Ask the user in T3 Code

Use T3 Code's native `request_user_input_async` when a user choice or clarification materially affects the work. Do not add or invoke a parallel `ask_user_question` extension.

- Ask a concise, self-contained question. Offer a few short options when they cover the likely choices, put the recommended option first, and leave free-text available for anything else.
- Bundle closely related choices into one call; separate unrelated decisions.
- Continue work that does not depend on the answer. Pause only the work that does depend on it.
- Use ordinary conversation for simple progress updates. Do not use the pending-request API to create a question; it is for reading or answering requests that T3 Code has already created.
