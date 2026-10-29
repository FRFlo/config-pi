# T3 Code compatibility for Pi extensions

T3 Code's Pi integration runs Pi itself in RPC mode. It is not the generic ACP
provider path, so Pi extensions continue to load from Pi's normal user and
project extension directories. Keep using the native Pi provider in T3 Code;
installing a Pi extension does not make it available to unrelated ACP agents
such as Codex or Claude Code.

## Supported extension behavior

T3 Code's Pi bridge supports registered tools, session/agent/tool hooks,
extension commands, model changes, notifications, and Pi's serializable
blocking dialogs (`select`, `confirm`, `input`, and `editor`). Custom tools and
background logic therefore continue to run in the Pi process.

The bridge does not render custom Pi TUI components, widgets, status/footer
text, terminal titles, or keyboard shortcuts. Use an extension command as the
invocation path for functionality that was previously reachable only by a
shortcut. For example, prompt snippets remain available through `/snippets`;
their TUI preview/widget is intentionally omitted in T3 Code. Supervisor,
observational-memory, bash-guard, agents-md, and terminal status decorations
are likewise not displayed, while their underlying commands and tools remain
available.

T3 Code currently maps every Pi `notify` event to a warning-style
`system_notice` and drops its notification level. Observational-memory
therefore suppresses routine info toasts in RPC mode to avoid false warning
markers; errors and warnings remain visible, and `/om:status` remains an
explicit visible report. Pi TUI notifications are unchanged. Preserving
notification severity correctly requires a change to T3 Code's Pi adapter.

## RPC dialog compatibility

Extensions must not call `ctx.ui.custom()` in RPC mode: custom TUI requests
cannot be represented by T3 Code's Pi bridge. Use the serializable dialog
methods instead. The ask-user-question text prompt now uses `input` when
restoring a pending question in RPC mode. For choices, T3 Code may return
free-form text directly from a `select` dialog rather than returning a
predefined option; ask-user-question treats an unmatched answer as “Other”
instead of reporting cancellation. Its remaining choice flows and bash-guard /
prompt-snippets menus use RPC-compatible dialogs.

When adding UI to an extension, check for `ctx.mode === "rpc"` (or the shared
`isHermesRpc` helper, which detects Pi's RPC mode) and provide a serializable
dialog fallback. Do not treat an absent widget/status display as a failure of
the extension's main behavior.
