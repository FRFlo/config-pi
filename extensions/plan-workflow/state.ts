import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Task = { title: string; description: string; verify: string; status: "pending" | "in_progress" | "done" | "blocked"; dependsOn?: number[]; evidence?: string };
export type Delegate = { taskId: string; status: "queued" | "running" | "waiting" | "cancel_requested" | "completed" | "failed" | "cancelled" | "interrupted"; step?: number; role?: string };
export type PlanState = { version: 1; id: string; session: string; cwd: string; phase: "planning" | "awaiting_approval" | "executing" | "paused" | "completed" | "cancelled"; request: string; title?: string; summary?: string; constraints?: string[]; risks?: string[]; tasks: Task[]; delegates?: Delegate[]; history?: { at: string; event: string; step?: number; status?: string; detail?: string }[]; planPath?: string; digest?: string; updatedAt: string };
export function record(state: PlanState, event: string, extra: { step?: number; status?: string; detail?: string } = {}): void {
  (state.history ??= []).push({ at: new Date().toISOString(), event, ...extra });
}
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function statePath(agentDir: string, cwd: string, session: string): string {
  return join(agentDir, "plan-workflow-state", `${hash(`${resolve(cwd)}\0${session}`)}.json`);
}
export async function readState(agentDir: string, cwd: string, session: string): Promise<PlanState | null> {
  try {
    const value = JSON.parse(await fs.readFile(statePath(agentDir, cwd, session), "utf8")) as PlanState;
    const phases = ["planning", "awaiting_approval", "executing", "paused", "completed", "cancelled"];
    const statuses = ["pending", "in_progress", "done", "blocked"];
    if (!value || value.version !== 1 || typeof value.id !== "string" || !value.id || value.session !== session || typeof value.cwd !== "string" || resolve(value.cwd) !== resolve(cwd) || !phases.includes(value.phase) || typeof value.request !== "string" || !Array.isArray(value.tasks)) throw new Error("Invalid plan state");
    if (value.tasks.some((task, index) => !task || typeof task.title !== "string" || typeof task.description !== "string" || typeof task.verify !== "string" || !statuses.includes(task.status) || (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.some((n) => !Number.isInteger(n) || n < 1 || n > index))))) throw new Error("Invalid plan tasks");
    if (value.delegates !== undefined && (!Array.isArray(value.delegates) || value.delegates.some((d) => !d || typeof d.taskId !== "string" || !["queued", "running", "waiting", "cancel_requested", "completed", "failed", "cancelled", "interrupted"].includes(d.status) || (d.step !== undefined && (!Number.isInteger(d.step) || d.step < 1 || d.step > value.tasks.length)) || (d.role !== undefined && typeof d.role !== "string")))) throw new Error("Invalid delegates");
    if (value.history !== undefined && !Array.isArray(value.history)) throw new Error("Invalid plan history");
    if (["awaiting_approval", "executing", "paused"].includes(value.phase) && (typeof value.planPath !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))) throw new Error("Invalid plan approval");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function saveState(agentDir: string, state: PlanState): Promise<void> {
  const target = statePath(agentDir, state.cwd, state.session);
  await fs.mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
  try { await fs.rename(temp, target); } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
}
export function todoKey(state: PlanState, index: number): string {
  return `[plan-${state.id.slice(0, 8)}] ${index + 1}. ${state.tasks[index].title}`;
}
export function renderPlan(state: PlanState): string {
  return [`# ${state.title}`, "", "## Objectif", state.summary, "", "## Demande", state.request, "", "## Contraintes", ...(state.constraints?.length ? state.constraints.map((v) => `- ${v}`) : ["- Aucune contrainte supplémentaire précisée."]), "", "## Risques et limites", ...(state.risks?.length ? state.risks.map((v) => `- ${v}`) : ["- Aucun risque supplémentaire précisé."]), "", "## Étapes", ...state.tasks.flatMap((t, i) => [`- [ ] ${i + 1}. ${t.title}`, `  - Travail : ${t.description}`, `  - Vérification : ${t.verify}`, ...(t.dependsOn?.length ? [`  - Dépend de : ${t.dependsOn.join(", ")}`] : [])]), ""].join("\n");
}
export async function savePlan(agentDir: string, state: PlanState, text: string): Promise<string> {
  const dir = join(agentDir, "plan-workflow-state", "plans");
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, `${hash(`${resolve(state.cwd)}\0${state.session}`)}-${hash(text).slice(0, 16)}.md`);
  await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; if (await fs.readFile(target, "utf8") !== text) throw new Error("Plan collision"); });
  return target;
}
export async function verifyPlan(state: PlanState): Promise<boolean> {
  if (!state.planPath || !state.digest) return false;
  try { return hash(await fs.readFile(state.planPath, "utf8")) === state.digest; } catch { return false; }
}
