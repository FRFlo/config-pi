# Subagent migration

## Installed runtime

- Pi was upgraded globally to `1.4.0` (`@tintinweb/pi-subagents@0.22.0` requires Pi `>=1.1.0`).
- The extension is installed in the global Pi package directory and listed in `settings.json`.
- `extensions/supervisor/index.ts` now delegates planner and reviewer runs through the extension's `pi.events` RPC channels. It does not import tintinweb internals.
- The former `extensions/interactive-subagents` submodule and its direct supervisor dependency were removed.
- Global agent definitions are in `agents/supervisor-planner.md` and `agents/supervisor-reviewer.md`.

Restart Pi sessions after this migration so Pi discovers the new package and agent definitions.

## Agent permissions

The planner has no tools, extensions, or skills. The reviewer has only `read`, `grep`, `find`, and `ls`; its instructions limit inspection to the request repository and prohibit modifications. This repository scope is an instruction, **not** an enforced filesystem boundary. The reviewer can potentially read outside the repository if it disregards the instruction. Do not treat it as a security sandbox.

## Validation

Validation completed:

- `bun test extensions/supervisor/logic.test.ts`: 17 passed, 0 failed (82 assertions).
- `npm --prefix npm ls --depth=0`: exit 0; `@tintinweb/pi-subagents@0.22.0` resolves.
- A live supervisor session exercised both RPC delegates: `supervisor-planner` produced the plan and `supervisor-reviewer` returned verified results for all three tasks.
- A live `tintinweb-smoke` workflow completed two agent calls. The second resumed the same `supervisor-planner` agent and retained the `TOKEN-ALPHA` context marker.

The first workflow attempt used headless `-p`, which exited while the workflow was detached and led to a stale-context error when it tried to append its result. Rerunning with a persistent RPC session completed successfully. The initial npm installation also reported three audit findings (one moderate, two high); review them separately before changing dependency versions. Pi also warned that the existing `pi-apply-patch` package declares `typebox` as a dependency rather than a host-provided peer dependency; this predates this migration.
