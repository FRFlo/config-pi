import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hash, readState, record, renderPlan, savePlan, saveState, statePath, todoKey, verifyPlan, type Delegate, type PlanState } from "./state";

const allowedDuringPlan = new Set(["read", "grep", "find", "ls", "glob", "webfetch", "web_search", "ask_user_question", "ask_question", "plan_submit", "plan_status"]);
const nonempty = Type.String({ minLength: 1, maxLength: 4000 });
const taskSchema = Type.Object({ title: nonempty, description: nonempty, verify: nonempty, depends_on: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 30 })) });
const agentDir = getAgentDir();
const getSession = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
const load = (ctx: ExtensionContext) => readState(agentDir, ctx.cwd, getSession(ctx));
const lock = <T>(ctx: ExtensionContext, fn: () => Promise<T>) => withFileMutationQueue(statePath(agentDir, ctx.cwd, getSession(ctx)), fn);
const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

function bridgeInventory(pi: ExtensionAPI): string {
  const bridge = process.env.T3_PI_MCP_EXTENSION_PATH;
  if (!bridge) return "Pont T3 non détecté dans cette session ; vérifie les outils disponibles avant de conclure qu’ils sont absents.";
  const catalog = pi.getAllTools();
  return ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"].map((name) => {
    const fullName = `mcp__t3-code__${name}`;
    const tool = catalog.find((item) => item.name === fullName && typeof item.sourceInfo?.path === "string" && resolve(item.sourceInfo.path) === resolve(bridge));
    return tool ? `${fullName} : ${tool.exposure}` : `${fullName} : non détecté ; vérifier par son nom avant de conclure à son absence`;
  }).join("\n");
}
function executionPrompt(state: PlanState, pi: ExtensionAPI): string {
  const tasks = state.tasks.map((task, i) => `${i + 1}. [${task.status}] ${task.title}\n   Titre todo : ${todoKey(state, i)}\n   Travail : ${task.description}\n   Vérification : ${task.verify}${task.dependsOn?.length ? `\n   Dépend de : ${task.dependsOn.join(", ")}` : ""}${task.evidence ? `\n   Preuve : ${task.evidence}` : ""}`).join("\n");
  const delegates = (state.delegates ?? []).map((item) => `${item.taskId}: ${item.status}${item.step ? `, étape ${item.step}` : ""}${item.role ? `, ${item.role}` : ""}`).join("\n");
  return `Le plan ci-dessous a été approuvé explicitement par l'utilisateur. Commence immédiatement son exécution.\nPlan : ${state.planPath}\nEmpreinte SHA-256 : ${state.digest}\nObjectif : ${state.summary}\n\n${tasks}\n\nTâches T3 déjà observées :\n${delegates || "aucune"}\nNe relance pas une tâche encore active.\n\nOutils du pont T3 détectés à ce tour :\n${bridgeInventory(pi)}\n\nT3 Code injecte directement ses outils MCP sous les noms mcp__t3-code__*. Vérifie les outils dont tu as besoin au moment de les utiliser ; certains sont différés et nécessitent tool_search. Respecte les instructions T3 injectées dans cette session : utilise les outils natifs de délégation lorsqu’ils sont disponibles et autorisés, consulte orchestrator_capabilities avant le premier delegate_task et suis next. Dans le champ task de chaque delegate_task, commence par [plan-step:N], où N est le numéro de l’étape concernée. Attends le résultat de la délégation et de sa revue avant de terminer l’étape ; ne lance pas ces appels dans le même lot que todo done. Ne sonde pas une tâche en cours ; après notification de fin T3, utilise task_status pour récupérer son résultat. Ne crée pas de thread principal pour une sous-tâche. Délègue une revue indépendante quand un réviseur autorisé est disponible ; sinon vérifie directement et signale l’absence de revue indépendante. Consulte todo. Pour les étapes sans entrée, ajoute uniquement leurs titres todo exacts dans une phase dédiée avec l’opération append ; ne réinitialise jamais la liste ni les tâches préexistantes. À la reprise, conserve les statuts déjà enregistrés. Utilise ensuite start et done après vérification, en respectant les dépendances. En cas de blocage, n’indique pas l’étape comme terminée et rapporte la raison. Quand toutes les étapes sont terminées, utilise plan_finish avec une preuve distincte pour chaque étape.`;
}

export default function (pi: ExtensionAPI) {
  const updateStatus = (ctx: ExtensionContext, state: PlanState | null) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("plan-workflow", state && state.phase !== "completed" && state.phase !== "cancelled" ? `plan: ${state.phase}` : undefined);
  };
  const queueExecution = (state: PlanState) => pi.sendMessage({ customType: "plan-execution", content: executionPrompt(state, pi), display: false }, { triggerTurn: true, deliverAs: "followUp" });

  pi.registerCommand("plan", {
    description: "Plan T3 : /plan <demande>, /plan status, /plan resume, /plan pause ou /plan cancel",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "status") {
        const state = await load(ctx);
        ctx.ui.notify(state ? `Plan ${state.phase} : ${state.title ?? state.request}\n${state.planPath ?? "Brouillon en cours"}` : "Aucun plan pour cette session. Utilise /plan <demande>.", "info");
        return;
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
        const state = await lock(ctx, async () => { const current = await load(ctx); if (!current || !["executing", "paused"].includes(current.phase)) throw new Error("Aucun plan approuvé à reprendre."); if (!await verifyPlan(current)) throw new Error("Plan absent ou modifié depuis son approbation : crée un nouveau plan."); current.phase = "executing"; record(current, "resumed"); await saveState(agentDir, current); updateStatus(ctx, current); return current; });
        queueExecution(state); return;
      }
      await lock(ctx, async () => {
        const existing = await load(ctx);
        if (existing && existing.phase !== "completed" && existing.phase !== "cancelled") throw new Error("Un plan est déjà actif. Utilise /plan status, /plan resume ou /plan cancel.");
        const state: PlanState = { version: 1, id: randomUUID(), session: getSession(ctx), cwd: ctx.cwd, phase: "planning", request: input, tasks: [], updatedAt: new Date().toISOString() };
        record(state, "started"); await saveState(agentDir, state); updateStatus(ctx, state);
      });
      pi.sendUserMessage(`Prépare un plan pour cette demande, sans modifier le projet : ${input}`);
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
    if ((state.phase === "planning" || state.phase === "awaiting_approval" || state.phase === "paused") && !allowedDuringPlan.has(event.toolName) && !isTrustedDiscovery(event.toolName) && !(state.phase === "paused" && isTrustedBridge(event.toolName, new Set(["task_cancel"])))) {
      return { block: true, reason: `Plan ${state.phase} : l'outil ${event.toolName} est bloqué.` };
    }
    if (state.phase === "executing" && !allowedDuringPlan.has(event.toolName) && !isTrustedBridge(event.toolName, new Set(["task_status", "task_cancel"])) && !await verifyPlan(state)) {
      return { block: true, reason: "Le plan approuvé est absent ou modifié ; l'exécution est bloquée." };
    }
    if (state.phase === "executing" && event.toolName === "todo") {
      const op = event.input.op; const title = event.input.task;
      const task = typeof title === "string" ? state.tasks.find((_entry, i) => todoKey(state, i) === title) : undefined;
      if (op === "init") return { block: true, reason: "Ne réinitialise pas les todos existants ; utilise append dans une phase dédiée." };
      if ((op === "start" || op === "done" || op === "drop" || op === "rm") && !task) return { block: true, reason: "Pendant le plan, cible une seule étape par son titre todo exact." };
      if (op === "rm") return { block: true, reason: "Les étapes du plan approuvé ne peuvent pas être supprimées des todos." };
      if ((op === "start" || op === "done") && task?.dependsOn?.some((n) => state.tasks[n - 1]?.status !== "done")) return { block: true, reason: "Les dépendances doivent être terminées avant cette étape." };
      if (op === "done" && task) { const step = state.tasks.indexOf(task) + 1; if ((state.delegates ?? []).some((item) => ["queued", "running", "waiting", "cancel_requested"].includes(item.status) && (item.step === undefined || item.step === step))) return { block: true, reason: "Une tâche T3 liée à cette étape est encore active." }; }
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await load(ctx);
    if (!state || state.phase === "completed" || state.phase === "cancelled") return;
    const instruction = state.phase === "planning" || state.phase === "awaiting_approval"
      ? `MODE PLAN ACTIF. Ne modifie aucun fichier du projet et ne délègue aucune implémentation. Explore avec les outils de lecture directement fournis par le harness T3 et Pi ; vérifie leur disponibilité quand tu en as besoin. Ne lance aucun shell, codemode ni sous-agent pendant le plan. Clarifie uniquement les décisions nécessaires. Prépare un plan concret avec résultat visé, périmètre, contraintes, risques, tâches ordonnées, dépendances, critères vérifiables et vérification finale. Identifie les tâches indépendantes pour le harness T3, sans lancer de sous-agent pendant le plan. Puis appelle plan_submit pour le présenter et demander l'approbation explicite. La confirmation approuve le plan et lance immédiatement l'exécution. Demande d'origine : ${state.request}`
      : state.phase === "paused" ? "Le plan est en pause. Ne reprends pas son exécution avant /plan resume." : executionPrompt(state, pi);
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
      const state = await load(ctx); if (!state || !["executing", "paused"].includes(state.phase)) return;
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
      if (state.tasks.some((task, i) => next[i] !== "pending" && next[i] !== "blocked" && task.dependsOn?.some((n) => next[n - 1] !== "done"))) return;
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
    name: "plan_submit", label: "Présenter le plan", description: "Présente un plan détaillé à l'utilisateur. Une confirmation explicite approuve le plan et déclenche immédiatement son exécution.",
    parameters: Type.Object({ title: nonempty, summary: nonempty, constraints: Type.Optional(Type.Array(nonempty, { maxItems: 20 })), risks: Type.Optional(Type.Array(nonempty, { maxItems: 20 })), tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 30 }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const state = await lock(ctx, async () => {
        const current = await load(ctx); if (!current || !["planning", "awaiting_approval"].includes(current.phase)) throw new Error("Aucun plan en préparation.");
        if (!params.title.trim() || !params.summary.trim() || params.tasks.some((t) => !t.title.trim() || !t.description.trim() || !t.verify.trim())) throw new Error("Chaque titre, description et vérification doit être renseigné.");
        if (new Set(params.tasks.map((task) => task.title.trim())).size !== params.tasks.length) throw new Error("Les titres des étapes doivent être uniques pour le suivi todo.");
        current.title = params.title.trim(); current.summary = params.summary.trim(); current.constraints = params.constraints; current.risks = params.risks; current.tasks = params.tasks.map((t, i) => {
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
        return result("Plan non approuvé. Il reste modifiable ; n'exécute rien.", state);
      }
      const approvedState = await lock(ctx, async () => {
        const latest = await load(ctx); if (!latest || latest.phase !== "awaiting_approval" || latest.digest !== state.digest || !await verifyPlan(latest)) throw new Error("Le plan a changé : une nouvelle approbation est nécessaire.");
        latest.phase = "executing"; record(latest, "approved", { detail: latest.digest }); await saveState(agentDir, latest); updateStatus(ctx, latest); return latest;
      });
      queueExecution(approvedState);
      return result("Plan approuvé. Exécution immédiatement programmée ; termine ce tour pour démarrer.", approvedState);
    },
  });
  pi.registerTool({
    name: "plan_status", label: "État du plan", description: "Lit le plan et l'état des étapes de la session.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) { const state = await load(ctx); return result(state ? JSON.stringify(state, null, 2) : "Aucun plan dans cette session.", state ?? {}); },
  });
  pi.registerTool({
    name: "plan_finish", label: "Terminer le plan", description: "Clôture le plan lorsque toutes ses étapes sont terminées dans todo et accompagnées de preuves.",
    parameters: Type.Object({ evidence: Type.Array(Type.Object({ task: nonempty, proof: nonempty }), { minItems: 1, maxItems: 30 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return lock(ctx, async () => {
        const state = await load(ctx); if (!state || state.phase !== "executing" || !await verifyPlan(state)) throw new Error("Aucun plan approuvé et intact en exécution.");
        if (state.tasks.some((task) => task.status !== "done")) throw new Error("Chaque étape doit être terminée dans todo avant de clôturer le plan.");
        if ((state.delegates ?? []).some(activeDelegate)) throw new Error("Des tâches T3 sont encore actives ; suis leur achèvement avant de clôturer.");
        for (const task of state.tasks) {
          const matches = params.evidence.filter((entry) => entry.task === task.title);
          if (matches.length !== 1 || !matches[0].proof.trim()) throw new Error(`Une preuve unique est requise pour l'étape : ${task.title}`);
          task.evidence = matches[0].proof.trim();
        }
        if (params.evidence.length !== state.tasks.length) throw new Error("La liste de preuves doit correspondre exactement aux étapes du plan.");
        state.phase = "completed"; record(state, "completed"); await saveState(agentDir, state); updateStatus(ctx, state); return result("Plan terminé.", state);
      });
    },
  });
}
