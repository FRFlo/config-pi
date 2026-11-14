import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "pi-t3-plan-test-"));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => dir, withFileMutationQueue: (_path: string, fn: () => unknown) => fn() }));
mock.module("typebox", () => ({ Type: { String: () => ({}), Object: () => ({}), Array: () => ({}), Integer: () => ({}), Union: () => ({}), Literal: () => ({}), Optional: () => ({}), Boolean: () => ({}) } }));
const { default: register } = await import("./index");
const { readState, statePath, todoKey } = await import("./state");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(session: string, confirm: () => Promise<boolean>, catalog: any[] = []) {
  const events = new Map<string, Function>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const sent: any[] = [];
  register({ getAllTools: () => catalog, on: (name: string, fn: Function) => { const previous = events.get(name); events.set(name, previous ? async (...args: any[]) => { const first = await previous(...args); const second = await fn(...args); return second ?? first; } : fn); }, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendUserMessage: (text: string) => sent.push({ user: text }), sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
  const ctx: any = { cwd: dir, mode: "rpc", hasUI: true, isIdle: () => true, abort: () => {}, sessionManager: { getSessionId: () => session }, ui: { confirm, notify: () => {}, setStatus: () => {} } };
  const invoke = (name: string, args: any) => tools.get(name).execute("test", args, undefined, undefined, ctx);
  return { events, tools, commands, sent, ctx, invoke };
}
const payload = { title: "Titre", summary: "But", tasks: [{ title: "Étape", description: "Travail", verify: "Commande et résultat" }] };

describe("plan T3", () => {
  test("bloque les outils non autorisés pendant le plan et après un refus", async () => {
    const h = harness("denied", async () => false);
    expect([...h.tools.keys()]).toEqual(["plan_submit", "plan_status", "plan_finish"]);
    await h.commands.get("plan").handler("Construire", h.ctx);
    for (const name of ["bash", "codemode", "task", "mcp__t3_code__delegate_task"]) expect((await h.events.get("tool_call")!({ toolName: name }, h.ctx)).block).toBe(true);
    expect(await h.events.get("tool_call")!({ toolName: "read" }, h.ctx)).toBeUndefined();
    await h.invoke("plan_submit", payload);
    expect((await readState(dir, dir, "denied"))?.phase).toBe("awaiting_approval");
    expect((await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).block).toBe(true);
    expect(h.sent.filter((x) => x.message).length).toBe(0);
  });
  test("reconnaît le pont T3 réel sans autoriser la délégation en plan", async () => {
    const previous = process.env.T3_PI_MCP_EXTENSION_PATH; const bridge = join(dir, "bridge.ts"); process.env.T3_PI_MCP_EXTENSION_PATH = bridge;
    try {
      const catalog = [
        { name: "tool_search", sourceInfo: { path: "builtin:tool-search" } },
        { name: "mcp__t3-code__orchestrator_capabilities", sourceInfo: { path: bridge } },
        { name: "mcp__t3-code__delegate_task", sourceInfo: { path: bridge } },
        { name: "mcp__t3-code__t3_project_read", sourceInfo: { path: join(dir, "impostor.ts") } },
      ];
      const h = harness("bridge", async () => false, catalog); await h.commands.get("plan").handler("Étudier", h.ctx);
      expect(await h.events.get("tool_call")!({ toolName: "tool_search" }, h.ctx)).toBeUndefined();
      expect(await h.events.get("tool_call")!({ toolName: "mcp__t3-code__orchestrator_capabilities" }, h.ctx)).toBeUndefined();
      expect((await h.events.get("tool_call")!({ toolName: "mcp__t3-code__delegate_task" }, h.ctx)).block).toBe(true);
      expect((await h.events.get("tool_call")!({ toolName: "mcp__t3-code__t3_project_read" }, h.ctx)).block).toBe(true);
    } finally { if (previous === undefined) delete process.env.T3_PI_MCP_EXTENSION_PATH; else process.env.T3_PI_MCP_EXTENSION_PATH = previous; }
  });
  test("démarre après accord et exige une preuve avant clôture", async () => {
    const h = harness("approved", async () => true); await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload);
    expect((await readState(dir, dir, "approved"))?.phase).toBe("executing");
    expect(h.sent.find((x) => x.message)?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(h.sent.find((x) => x.message)?.message.content).toContain("ne réinitialise jamais");
    expect(h.sent.find((x) => x.message)?.message.content).toContain("mcp__t3-code__");
    expect(await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).toBeUndefined();
    await expect(h.invoke("plan_finish", {})).rejects.toThrow();
    const key = todoKey((await readState(dir, dir, "approved"))!, 0);
    await h.events.get("tool_result")!({ toolName: "todo", isError: false, details: { phases: [{ tasks: [{ content: key, status: "completed" }] }] } }, h.ctx);
    await expect(h.invoke("plan_finish", { evidence: [] })).rejects.toThrow();
    await h.invoke("plan_finish", { evidence: [{ task: "Étape", proof: "test : OK" }] }); const completed = (await readState(dir, dir, "approved"))!; expect(completed.phase).toBe("completed");
    expect(completed.history?.map((entry) => entry.event)).toEqual(["started", "submitted", "approved", "step_updated", "completed"]);
  });
  test("observe les tâches du pont T3 et bloque la clôture tant qu’une tâche est active", async () => {
    const previous = process.env.T3_PI_MCP_EXTENSION_PATH; const bridge = join(dir, "bridge-exec.ts"); process.env.T3_PI_MCP_EXTENSION_PATH = bridge;
    try {
      const catalog = ["delegate_task", "task_status", "task_cancel"].map((name) => ({ name: "mcp__t3-code__" + name, sourceInfo: { path: bridge }, exposure: name === "task_cancel" ? "deferred" : "direct" }));
      const h = harness("delegation", async () => true, catalog); await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload);
      expect(h.sent.find((x) => x.message)?.message.content).toContain("mcp__t3-code__delegate_task : direct");
      expect(h.sent.find((x) => x.message)?.message.content).toContain("mcp__t3-code__task_cancel : deferred");
      const event = (tool: string, status: string) => h.events.get("tool_result")!({ toolName: "mcp__t3-code__" + tool, isError: false, input: tool === "delegate_task" ? { task: "[plan-step:1] Implémenter", role: "implementation" } : {}, structuredContent: { structuredContent: { taskId: "child-task", status } } }, h.ctx);
      await event("delegate_task", "running");
      await h.events.get("tool_result")!({ toolName: "mcp__t3-code__task_status", isError: false, structuredContent: { structuredContent: { taskId: "child-task", status: "completed", hasPendingChildRuns: true } } }, h.ctx);
      expect((await readState(dir, dir, "delegation"))?.delegates?.[0].status).toBe("waiting");
      await event("delegate_task", "running");
      expect((await readState(dir, dir, "delegation"))?.delegates).toEqual([{ taskId: "child-task", status: "running", step: 1, role: "implementation" }]);
      const stepKey = todoKey((await readState(dir, dir, "delegation"))!, 0);
      expect((await h.events.get("tool_call")!({ toolName: "todo", input: { op: "done", task: stepKey } }, h.ctx)).block).toBe(true);
      const key = todoKey((await readState(dir, dir, "delegation"))!, 0);
      await h.events.get("tool_result")!({ toolName: "todo", isError: false, details: { phases: [{ tasks: [{ content: key, status: "completed" }] }] } }, h.ctx);
      const proof = { evidence: [{ task: "Étape", proof: "OK" }] };
      await expect(h.invoke("plan_finish", proof)).rejects.toThrow("encore actives");
      await h.commands.get("plan").handler("pause", h.ctx); await h.commands.get("plan").handler("resume", h.ctx);
      expect(h.sent.filter((x) => x.message).at(-1).message.content).toContain("child-task: running, étape 1, implementation");
      await event("task_status", "completed"); await h.invoke("plan_finish", proof);
      expect((await readState(dir, dir, "delegation"))?.phase).toBe("completed");
    } finally { if (previous === undefined) delete process.env.T3_PI_MCP_EXTENSION_PATH; else process.env.T3_PI_MCP_EXTENSION_PATH = previous; }
  });
  test("redemande explicitement l’approbation même pour le même plan", async () => {
    const messages: string[] = []; const h = harness("approval-nonce", async () => false);
    h.ctx.ui.confirm = async (_title: string, message: string) => { messages.push(message); return false; };
    await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload); await h.invoke("plan_submit", payload);
    expect(messages).toHaveLength(2); expect(messages[0]).not.toBe(messages[1]);
  });
  test("n'approuve pas sans interface de confirmation", async () => {
    const h = harness("headless", async () => true); h.ctx.hasUI = false;
    await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload);
    expect((await readState(dir, dir, "headless"))?.phase).toBe("awaiting_approval");
    expect(h.sent.filter((x) => x.message).length).toBe(0);
  });
  test("l'annulation empêche une approbation tardive", async () => {
    let answer!: (value: boolean) => void; let notify!: () => void;
    const ready = new Promise<void>((resolve) => { notify = resolve; });
    const h = harness("cancelled", () => new Promise((resolve) => { answer = resolve; notify(); }));
    await h.commands.get("plan").handler("Construire", h.ctx); const pending = h.invoke("plan_submit", payload); await ready;
    await h.commands.get("plan").handler("cancel", h.ctx); answer(true);
    await expect(pending).rejects.toThrow("changé"); expect((await readState(dir, dir, "cancelled"))?.phase).toBe("cancelled");
    expect(h.sent.filter((x) => x.message).length).toBe(0);
  });
  test("impose les dépendances avant de démarrer ou clôturer une étape", async () => {
    const h = harness("deps", async () => true); await h.commands.get("plan").handler("Construire", h.ctx);
    await h.invoke("plan_submit", { ...payload, tasks: [...payload.tasks, { title: "Suite", description: "Suite", verify: "Résultat", depends_on: [1] }] });
    const snapshot = (await readState(dir, dir, "deps"))!; const first = todoKey(snapshot, 0), second = todoKey(snapshot, 1);
    const update = (tasks: any[]) => h.events.get("tool_result")!({ toolName: "todo", isError: false, details: { phases: [{ tasks }] } }, h.ctx);
    expect((await h.events.get("tool_call")!({ toolName: "todo", input: { op: "done", task: second } }, h.ctx)).block).toBe(true);
    await update([{ content: first, status: "completed" }, { content: second, status: "pending" }]);
    expect(await h.events.get("tool_call")!({ toolName: "todo", input: { op: "done", task: second } }, h.ctx)).toBeUndefined();
    await update([{ content: first, status: "completed" }, { content: second, status: "completed" }]);
    await h.invoke("plan_finish", { evidence: [{ task: "Étape", proof: "OK" }, { task: "Suite", proof: "OK" }] });
  });
  test("refuse la reprise si le plan approuvé a été modifié", async () => {
    const h = harness("changed", async () => true); await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload);
    const state = (await readState(dir, dir, "changed"))!; await writeFile(state.planPath!, "modifié");
    expect((await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).block).toBe(true);
    await expect(h.commands.get("plan").handler("resume", h.ctx)).rejects.toThrow("modifié");
  });
  test("reprend un plan inchangé après pause sans redemander d'accord", async () => {
    const h = harness("resume", async () => true); await h.commands.get("plan").handler("Construire", h.ctx); await h.invoke("plan_submit", payload);
    await h.commands.get("plan").handler("pause", h.ctx); expect((await readState(dir, dir, "resume"))?.phase).toBe("paused");
    expect((await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).block).toBe(true);
    await h.commands.get("plan").handler("resume", h.ctx); expect((await readState(dir, dir, "resume"))?.phase).toBe("executing");
    expect(h.sent.filter((x) => x.message).length).toBe(2);
  });
  test("bloque les outils si l’état est illisible", async () => {
    const h = harness("corrupt", async () => true); await h.commands.get("plan").handler("Construire", h.ctx);
    await writeFile(statePath(dir, dir, "corrupt"), "{");
    expect((await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).block).toBe(true);
    await writeFile(statePath(dir, dir, "corrupt"), JSON.stringify({ version: 1, session: "corrupt", cwd: dir, phase: "unknown", request: "x", tasks: [] }));
    expect((await h.events.get("tool_call")!({ toolName: "write" }, h.ctx)).block).toBe(true);
  });
  test("n'approuve pas si le plan change pendant la confirmation", async () => {
    let respond!: (value: boolean) => void; let ready!: () => void; const readyPromise = new Promise<void>((resolve) => { ready = resolve; }); const h = harness("race", () => new Promise((resolve) => { respond = resolve; ready(); }));
    await h.commands.get("plan").handler("Construire", h.ctx); const pending = h.invoke("plan_submit", payload);
    await readyPromise;
    expect(respond).toBeDefined(); const state = (await readState(dir, dir, "race"))!; expect(await readFile(state.planPath!, "utf8")).toContain("Étape"); await writeFile(state.planPath!, "altéré"); respond(true);
    await expect(pending).rejects.toThrow("changé"); expect((await readState(dir, dir, "race"))?.phase).toBe("awaiting_approval");
  });
});
