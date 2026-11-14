import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { todoKey, type PlanState } from "./state";

export const planToolDescriptions = {
  submit: "Present a detailed plan to the user. Explicit confirmation approves the plan and immediately starts execution.",
  status: "Read the plan and the status of its steps in this session.",
  finish: "Complete the plan when every step is marked done in todo and supported by evidence.",
};

export const planStartMessage = (request: string) => `Prepare a plan for this request without modifying the project: ${request}`;
export const pausedPrompt = "The plan is paused. Do not resume execution until /plan resume.";

export function planningPrompt(state: PlanState): string {
  return `PLAN MODE ACTIVE. Do not modify project files or delegate implementation. Explore using the read tools provided directly by the T3 harness and Pi; check their availability when needed. Do not run a shell, codemode, or subagent while planning. Clarify only necessary decisions. Prepare a concrete plan with the desired outcome, scope, constraints, risks, ordered tasks, dependencies, verifiable criteria, and final verification. Identify independent tasks for the T3 harness without launching subagents while planning. Then call plan_submit to present the plan and request explicit approval. Confirmation approves the plan and immediately starts execution. Original request: ${state.request}`;
}

function bridgeInventory(pi: ExtensionAPI): string {
  const bridge = process.env.T3_PI_MCP_EXTENSION_PATH;
  if (!bridge) return "T3 bridge not detected in this session; check tool availability before concluding that tools are absent.";
  const catalog = pi.getAllTools();
  return ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"].map((name) => {
    const fullName = `mcp__t3-code__${name}`;
    const tool = catalog.find((item) => item.name === fullName && typeof item.sourceInfo?.path === "string" && resolve(item.sourceInfo.path) === resolve(bridge));
    return tool ? `${fullName} : ${tool.exposure}` : `${fullName} : not detected; check by name before concluding it is absent`;
  }).join("\n");
}

export function executionPrompt(state: PlanState, pi: ExtensionAPI): string {
  const tasks = state.tasks.map((task, i) => `${i + 1}. [${task.status}] ${task.title}\n   Todo title: ${todoKey(state, i)}\n   Work: ${task.description}\n   Verification: ${task.verify}${task.dependsOn?.length ? `\n   Depends on: ${task.dependsOn.join(", ")}` : ""}${task.evidence ? `\n   Evidence: ${task.evidence}` : ""}`).join("\n");
  const delegates = (state.delegates ?? []).map((item) => `${item.taskId}: ${item.status}${item.step ? `, step ${item.step}` : ""}${item.role ? `, ${item.role}` : ""}`).join("\n");
  return `The user has explicitly approved the plan below. Start executing it immediately.\nPlan: ${state.planPath}\nSHA-256 digest: ${state.digest}\nObjective: ${state.summary}\n\n${tasks}\n\nT3 tasks already observed:\n${delegates || "none"}\nDo not restart an active task.\n\nT3 bridge tools detected this turn:\n${bridgeInventory(pi)}\n\nT3 Code directly injects its MCP tools under the names mcp__t3-code__*. Check the tools you need when using them; some are deferred and require tool_search. Follow the T3 instructions injected into this session: use native delegation tools when available and authorized, consult orchestrator_capabilities before the first delegate_task, and follow next. Begin the task field of each delegate_task with [plan-step:N], where N is the relevant step number. Wait for the delegation result and its review before completing the step; do not issue these calls in the same batch as todo done. Do not poll a running task; after the T3 completion notification, use task_status to retrieve its result. Do not create a top-level thread for a subtask. Delegate an independent review when an authorized reviewer is available; otherwise verify directly and report the absence of an independent review. Consult todo. For steps without an entry, append only their exact todo titles in a dedicated phase; never reinitialize the list or existing tasks. On resumption, preserve recorded statuses. Then use start and done after verification, respecting dependencies. If blocked, do not mark the step complete and report the reason. When all steps are complete, use plan_finish with distinct evidence for each step.`;
}
