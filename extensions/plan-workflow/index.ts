import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hash, listStates, readState, record, renderPlan, savePlan, saveState, statePath, todoKey, verifyPlan, type Delegate, type PlanState } from "./state";
import { executionPrompt, planningPrompt, pausedPrompt, planStartMessage, planToolDescriptions } from "./prompts";

const allowedDuringPlan = new Set(["read", "grep", "find", "ls", "glob", "webfetch", "web_search", "ask_user_question", "ask_question", "plan_submit", "plan_status", "todo"]);
const nonempty = Type.String({ minLength: 1, maxLength: 4000 });
const taskSchema = Type.Object({ title: nonempty, description: nonempty, verify: nonempty, depends_on: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 30 })) });
const agentDir = getAgentDir();
const getSession = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
const load = (ctx: ExtensionContext) => readState(agentDir, ctx.cwd, getSession(ctx));
const lock = <T>(ctx: ExtensionContext, fn: () => Promise<T>) => withFileMutationQueue(statePath(agentDir, ctx.cwd, getSession(ctx)), fn);
const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });
const withSessionLease = async <T>(cwd: string, session: string, fn: () => Promise<T>): Promise<T> => {
  const path = `${statePath(agentDir, cwd, session)}.lease`;
  const handle = await fs.open(path, "wx").catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw new Error("Une reprise ou un transfert de ce plan est déjà en cours ; si le processus a été interrompu, vérifie la session avant de supprimer son fichier .lease."); throw error; });
  try { return await fn(); } finally { await handle.close(); await fs.unlink(path); }
};

export default function (pi: ExtensionAPI) {
  const updateStatus = (ctx: ExtensionContext, state: PlanState | null) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("plan-workflow", state && state.phase !== "completed" && state.phase !== "cancelled" ? `plan: ${state.phase}` : undefined);
  };
  const queueExecution = (state: PlanState) => pi.sendMessage({ customType: "plan-execution", content: executionPrompt(state, pi), display: false }, { triggerTurn: true, deliverAs: "followUp" });

  pi.registerCommand("plan", {
    description: "Plan : /plan <demande>, /plan status, /plan list, /plan resume [id], /plan pause ou /plan cancel",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "status") {
        const state = await load(ctx);
        ctx.ui.notify(state ? `Plan ${state.phase} : ${state.title ?? state.request}\n${state.planPath ?? "Brouillon en cours"}` : "Aucun plan pour cette session. Utilise /plan <demande>.", "info");
        return;
      }
      if (input === "list") {
        const plans = await listStates(agentDir, ctx.cwd);
        ctx.ui.notify(plans.length ? plans.map((state) => `${state.id} | ${state.phase} | ${state.title ?? state.request} | session ${state.session}`).join("\n") : "Aucun plan pour ce projet.", "info"); return;
      }
      if (input.startsWith("resume ")) {
        const id = input.slice(7).trim();
        const matches = (await listStates(agentDir, ctx.cwd)).filter((state) => state.id === id && state.session !== getSession(ctx) && state.phase === "paused");
        if (matches.length !== 1) throw new Error("Plan introuvable ou ambigu : utilise /plan list et indique l'identifiant complet d'un plan en pause.");
        const source = matches[0];
        const state = await withSessionLease(ctx.cwd, source.session, () => withSessionLease(ctx.cwd, getSession(ctx), () => withFileMutationQueue(statePath(agentDir, ctx.cwd, source.session), () => lock(ctx, async () => {
          const old = await readState(agentDir, ctx.cwd, source.session); const current = await load(ctx);
          if (!old || old.phase !== "paused" || old.id !== id || !await verifyPlan(old)) throw new Error("Le plan source n'est plus disponible ou a été modifié.");
          if (current && !["completed", "cancelled"].includes(current.phase)) throw new Error("Un plan est déjà actif dans cette session.");
          if ((old.delegates ?? []).some((item) => ["queued", "running", "waiting", "cancel_requested"].includes(item.status))) throw new Error("Des tâches T3 sont encore actives dans la session d'origine : termine-les ou annule-les avant le transfert.");
          const moved: PlanState = { ...old, session: getSession(ctx), phase: "executing", delegates: [], todoRestorePending: true, history: [...(old.history ?? [])] };
          record(moved, "transferred", { detail: source.session });
          old.phase = "cancelled"; record(old, "transferred_out", { detail: moved.session });
          await saveState(agentDir, moved);
          try { await saveState(agentDir, old); } catch (error) { await fs.unlink(statePath(agentDir, ctx.cwd, moved.session)).catch(() => {}); throw error; }
          updateStatus(ctx, moved); return moved;
        }))));
        queueExecution(state); return;
      }
      if (input === "cancel") {
        await lock(ctx, async () => { const state = await load(ctx); if (!state) return; state.phase = "cancelled"; record(state, "cancelled"); await saveState(agentDir, state); updateStatus(ctx, state); });
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify("Plan arrêté pour cette session. Les tâches T3 déjà lancées ne sont pas annulées automatiquement.", "info"); return;
      }
      if (input === "pause") {
        await lock(ctx, async () => { const state = await load(ctx); if (!state || state.phase !== "executing") throw new Error("Aucune exécution en cours."); state.phase = "paused"; record(state, "paused"); await saveState(agentDir, state); updateStatus(ctx, state); });
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify("Exécution du plan en pause. Les tâches T3 déjà lancées ne sont pas annulées automatiquement.", "info"); return;
      }
      if (input === "resume") {
        const state = await withSessionLease(ctx.cwd, getSession(ctx), () => lock(ctx, async () => { const current = await load(ctx); if (!current || !["executing", "paused"].includes(current.phase)) throw new Error("Aucun plan approuvé à reprendre."); if (!await verifyPlan(current)) throw new Error("Plan absent ou modifié depuis son approbation : crée un nouveau plan."); current.phase = "executing"; record(current, "resumed"); await saveState(agentDir, current); updateStatus(ctx, current); return current; }));
        queueExecution(state); return;
      }
      await lock(ctx, async () => {
        const existing = await load(ctx);
        if (existing && existing.phase !== "completed" && existing.phase !== "cancelled") throw new Error("Un plan est déjà actif. Utilise /plan status, /plan resume ou /plan cancel.");
        const state: PlanState = { version: 1, id: randomUUID(), session: getSession(ctx), cwd: ctx.cwd, phase: "planning", request: input, tasks: [], updatedAt: new Date().toISOString() };
        record(state, "started"); await saveState(agentDir, state); updateStatus(ctx, state);
      });
      pi.sendUserMessage(planStartMessage(input));
    },
  });

  pi.on("session_start", async (_event, ctx) => { updateStatus(ctx, await load(ctx)); });
  const safeBridgeTools = new Set(["orchestrator_capabilities", "task_status", "t3_environment_read", "t3_project_read", "t3_thread_read", "t3_thread_search"]);
  const isTrustedBridge = (name: string, allowed: ReadonlySet<string>): boolean => {
    const match = /^mcp__t3[-_]code__(.+)$/.exec(name);
    const bridge = process.env.T3_PI_MCP_EXTENSION_PATH;
    return !!match && allowed.has(match[1]) && !!bridge && pi.getAllTools().some((tool) => tool.name === name && typeof tool.sourceInfo?.path === "string" && resolve(tool.sourceInfo.path) === resolve(bridge));
  };
  const isTrustedDiscovery = (name: string): boolean => {
    const catalog = pi.getAllTools();
    if (name === "tool_search") return catalog.some((tool) => tool.name === name && tool.sourceInfo?.path === "builtin:tool-search");
    return isTrustedBridge(name, safeBridgeTools);
  };
  pi.on("tool_call", async (event, ctx) => {
    let state: PlanState | null;
    try { state = await load(ctx); } catch { return { block: true, reason: "Impossible de lire l’état du plan ; appel bloqué jusqu’à résolution." }; }
    if (!state) return;
    if (state.phase === "planning" && isTrustedBridge(event.toolName, new Set(["delegate_task"]))) {
      if (event.input?.interactionMode !== "plan" || !["research", "review"].includes(String(event.input?.role))) return { block: true, reason: "Pendant le plan, délègue uniquement une recherche ou une revue avec interactionMode: plan et des instructions explicites de lecture seule." };
      return;
    }
    if ((state.phase === "planning" || state.phase === "awaiting_approval" || state.phase === "paused") && !allowedDuringPlan.has(event.toolName) && !isTrustedDiscovery(event.toolName) && !isTrustedBridge(event.toolName, new Set(["task_cancel"]))) {
      return { block: true, reason: `Plan ${state.phase} : l'outil ${event.toolName} est bloqué.` };
    }
    if (state.phase === "executing" && !await verifyPlan(state)) {
      return { block: true, reason: "Le plan approuvé est absent ou modifié ; l'exécution est bloquée." };
    }
    if (state.phase === "executing" && event.toolName === "todo") {
      const op = event.input.op; const title = event.input.task;
      const task = typeof title === "string" ? state.tasks.find((_entry, i) => todoKey(state, i) === title) : undefined;
      if (op === "init") return { block: true, reason: "Ne réinitialise pas les todos existants ; utilise append dans une phase dédiée." };
      if (op === "append" && (!Array.isArray(event.input.items) || event.input.items.some((item: unknown) => typeof item !== "string" || !state.tasks.some((_entry, i) => todoKey(state, i) === item)))) return { block: true, reason: `Utilise uniquement les titres todo exacts du plan : ${state.tasks.map((_entry, i) => todoKey(state, i)).join(" ; ")}` };
      if ((op === "start" || op === "drop" || op === "rm") && !task) return { block: true, reason: `Pendant le plan, cible une seule étape par son titre todo exact : ${state.tasks.map((_entry, i) => todoKey(state, i)).join(" ; ")}` };
      if (op === "rm") return { block: true, reason: "Les étapes du plan approuvé ne peuvent pas être supprimées des todos." };
      if ((op === "start" || op === "done") && task?.dependsOn?.some((n) => state.tasks[n - 1]?.status !== "done")) return { block: true, reason: "Les dépendances doivent être terminées avant cette étape." };
      if (op === "done" && task) { const step = state.tasks.indexOf(task) + 1; if ((state.delegates ?? []).some((item) => ["queued", "running", "waiting", "cancel_requested"].includes(item.status) && (item.step === undefined || item.step === step))) return { block: true, reason: "Une tâche T3 liée à cette étape est encore active." }; }
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await load(ctx);
    if (!state || state.phase === "completed" || state.phase === "cancelled") return;
    const instruction = state.phase === "planning" || state.phase === "awaiting_approval"
      ? planningPrompt(state)
      : state.phase === "paused" ? pausedPrompt : executionPrompt(state, pi);
    return { systemPrompt: `${event.systemPrompt}\n\n${instruction}` };
  });

  const delegateTools = new Set(["delegate_task", "task_status", "task_cancel"]);
  const activeDelegate = (item: Delegate) => ["queued", "running", "waiting", "cancel_requested"].includes(item.status);
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !isTrustedBridge(event.toolName, delegateTools)) return;
    const wrapped = event.structuredContent;
    if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) return;
    const nested = "structuredContent" in wrapped ? wrapped.structuredContent : wrapped;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return;
    const data = nested as Record<string, unknown>;
    const known = ["queued", "running", "waiting", "cancel_requested", "completed", "failed", "cancelled", "interrupted"];
    if (typeof data.taskId !== "string" || !data.taskId || typeof data.status !== "string" || !known.includes(data.status)) return;
    const status = (data.hasPendingChildRuns === true && data.status === "completed" ? "waiting" : data.status) as Delegate["status"];
    await lock(ctx, async () => {
      const state = await load(ctx); if (!state || !["planning", "awaiting_approval", "executing", "paused"].includes(state.phase)) return;
      const delegates = state.delegates ??= []; const existing = delegates.find((item) => item.taskId === data.taskId);
      if (existing?.status === status) return;
      const marker = typeof event.input?.task === "string" ? /^\s*\[plan-step:(\d+)\]/.exec(event.input.task) : null;
      const proposedStep = marker ? Number(marker[1]) : undefined;
      const step = proposedStep && proposedStep <= state.tasks.length ? proposedStep : undefined;
      const role = typeof event.input?.role === "string" ? event.input.role : undefined;
      if (existing) { existing.status = status; if (step) existing.step = step; if (role) existing.role = role; }
      else delegates.push({ taskId: data.taskId as string, status, ...(step ? { step } : {}), ...(role ? { role } : {}) });
      record(state, "delegate_observed", { status, detail: data.taskId as string, ...(step ? { step } : {}) }); await saveState(agentDir, state);
    });
  });

  // Pi's existing todo extension persists its state in the session and reports phases in tool results.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "todo" || event.isError || !event.details || typeof event.details !== "object") return;
    const phases = (event.details as { phases?: unknown }).phases;
    if (!Array.isArray(phases)) return;
    const items = phases.flatMap((phase) => phase && typeof phase === "object" && Array.isArray(phase.tasks) ? phase.tasks : []);
    await lock(ctx, async () => {
      const state = await load(ctx);
      if (!state || state.phase !== "executing" || !await verifyPlan(state)) return;
      const next = state.tasks.map((_task, index) => {
        const matches = items.filter((item) => item && typeof item === "object" && item.content === todoKey(state, index));
        if (matches.length !== 1) return null;
        const status = matches[0].status;
        return status === "completed" ? "done" : status === "abandoned" ? "blocked" : status === "pending" || status === "in_progress" ? status : null;
      });
      if (next.some((status) => status === null)) return;
      // A new Pi session has a fresh todo list: restore completed entries before
      // accepting its snapshot as authoritative for the transferred plan.
      if (state.todoRestorePending && state.tasks.some((task, i) => task.status === "done" && next[i] !== "done")) return;
      if (state.tasks.some((task, i) => next[i] !== "pending" && next[i] !== "blocked" && task.dependsOn?.some((n) => next[n - 1] !== "done"))) return;
      state.todoRestorePending = false;
      for (let i = 0; i < state.tasks.length; i++) {
        const task = state.tasks[i]; const status = next[i]!;
        if (task.status === status) continue;
        task.status = status; task.evidence = undefined;
        record(state, "step_updated", { step: i + 1, status });
      }
      await saveState(agentDir, state);
    });
  });

  pi.registerTool({
    name: "plan_submit", label: "Présenter le plan", description: planToolDescriptions.submit,
    parameters: Type.Object({ title: nonempty, summary: nonempty, constraints: Type.Optional(Type.Array(nonempty, { maxItems: 20 })), risks: Type.Optional(Type.Array(nonempty, { maxItems: 20 })), review: Type.Object({ scope: nonempty, dependencies: nonempty, verification: nonempty, risks: nonempty }), tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 30 }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const state = await lock(ctx, async () => {
        const current = await load(ctx); if (!current || !["planning", "awaiting_approval"].includes(current.phase)) throw new Error("Aucun plan en préparation.");
        if ((current.delegates ?? []).some(activeDelegate)) throw new Error("Attends la fin des recherches et revues déléguées avant de soumettre le plan.");
        if (!params.title.trim() || !params.summary.trim() || params.tasks.some((t) => !t.title.trim() || !t.description.trim() || !t.verify.trim())) throw new Error("Chaque titre, description et vérification doit être renseigné.");
        if (new Set(params.tasks.map((task) => task.title.trim())).size !== params.tasks.length) throw new Error("Les titres des étapes doivent être uniques pour le suivi todo.");
        if (!params.review || [params.review.scope, params.review.dependencies, params.review.verification, params.review.risks].some((v) => typeof v !== "string" || !v.trim())) throw new Error("La revue du plan doit couvrir le périmètre, les dépendances, les vérifications et les risques.");
        current.title = params.title.trim(); current.summary = params.summary.trim(); current.constraints = params.constraints; current.risks = params.risks; current.review = params.review; current.tasks = params.tasks.map((t, i) => {
          const dependsOn = [...new Set(t.depends_on ?? [])];
          if (dependsOn.some((n) => n > i)) throw new Error(`Dépendance invalide pour l’étape ${i + 1} : chaque dépendance doit désigner une étape précédente.`);
          return { title: t.title.trim(), description: t.description.trim(), verify: t.verify.trim(), dependsOn, status: "pending" as const };
        });
        const text = renderPlan(current); if (text.length > 20000) throw new Error("Plan trop long pour une validation lisible.");
        current.planPath = await savePlan(agentDir, current, text); current.digest = hash(text); current.phase = "awaiting_approval"; record(current, "submitted", { detail: current.digest }); await saveState(agentDir, current); updateStatus(ctx, current); return current;
      });
      if (!ctx.hasUI) return result(`Plan prêt : ${state.planPath}. Aucun dialogue disponible ; le plan n'est pas approuvé.`, state);
      const approved = await ctx.ui.confirm("Approuver et exécuter le plan ?", `${renderPlan(state)}\n\nDemande : ${randomUUID()}\nApprouver démarre immédiatement l'exécution.`, { signal });
      if (!approved || signal?.aborted) {
        await lock(ctx, async () => { const current = await load(ctx); if (current && current.phase === "awaiting_approval" && current.digest === state.digest) { record(current, "approval_declined"); await saveState(agentDir, current); } });
        return result("Plan non approuvé. Il reste modifiable. Demande ou applique le retour de l'utilisateur, mets à jour le plan puis resoumets-le avec plan_submit ; n'exécute rien avant une approbation explicite.", state);
      }
      const approvedState = await lock(ctx, async () => {
        const latest = await load(ctx); if (!latest || latest.phase !== "awaiting_approval" || latest.digest !== state.digest || !await verifyPlan(latest)) throw new Error("Le plan a changé : une nouvelle approbation est nécessaire.");
        latest.phase = "executing"; record(latest, "approved", { detail: latest.digest }); await saveState(agentDir, latest); updateStatus(ctx, latest); return latest;
      });
      queueExecution(approvedState);
      return result(`Plan approuvé. Exécution immédiatement programmée ; termine ce tour pour démarrer. Titres todo exacts : ${approvedState.tasks.map((_task, i) => todoKey(approvedState, i)).join(" ; ")}`, approvedState);
    },
  });
  pi.registerTool({
    name: "plan_status", label: "État du plan", description: planToolDescriptions.status, parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) { const state = await load(ctx); return result(state ? JSON.stringify(state, null, 2) : "Aucun plan dans cette session.", state ?? {}); },
  });
  pi.registerTool({
    name: "plan_finish", label: "Terminer le plan", description: planToolDescriptions.finish,
    parameters: Type.Object({ evidence: Type.Array(Type.Object({ task: nonempty, proof: nonempty }), { minItems: 1, maxItems: 30 }), final_verification: Type.Object({ creation: nonempty, review: nonempty, correction: nonempty, checks: nonempty, limitations: nonempty }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return lock(ctx, async () => {
        const state = await load(ctx); if (!state || state.phase !== "executing" || !await verifyPlan(state)) throw new Error("Aucun plan approuvé et intact en exécution.");
        if (state.todoRestorePending) throw new Error("Restaure et vérifie les tâches todo de cette session avant de clôturer le plan transféré.");
        if (state.tasks.some((task) => task.status !== "done")) throw new Error("Chaque étape doit être terminée dans todo avant de clôturer le plan.");
        if ((state.delegates ?? []).some(activeDelegate)) throw new Error("Des tâches T3 sont encore actives ; suis leur achèvement avant de clôturer.");
        for (const task of state.tasks) {
          const matches = params.evidence.filter((entry) => entry.task === task.title);
          if (matches.length !== 1 || !matches[0].proof.trim()) throw new Error(`Une preuve unique est requise pour l'étape : ${task.title}`);
          task.evidence = matches[0].proof.trim();
        }
        if (params.evidence.length !== state.tasks.length) throw new Error("La liste de preuves doit correspondre exactement aux étapes du plan.");
        if (!params.final_verification || [params.final_verification.creation, params.final_verification.review, params.final_verification.correction, params.final_verification.checks, params.final_verification.limitations].some((v) => typeof v !== "string" || !v.trim())) throw new Error("La vérification finale doit préciser la création, la revue, la correction, la revérification et les limites.");
        state.finalVerification = params.final_verification;
        state.phase = "completed"; record(state, "completed"); await saveState(agentDir, state); updateStatus(ctx, state); return result("Plan terminé.", state);
      });
    },
  });
}
