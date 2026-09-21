/**
 * Motor do Flow Builder — terceiro relógio do produto (ver cabeçalho da
 * migration 0382 para o porquê de não fundir com automação nem follow-up).
 *
 * evento → encontrar flow ativo → criar execução → executar nó → persistir
 * estado → determinar próximo nó → continuar → pausar quando necessário →
 * retomar depois. Idempotência via índice único (flow_id, contact_id) em
 * execuções não-terminais (migration 0382) — a 2ª tentativa de iniciar o
 * mesmo par recebe 23505 e é tratada como "já em andamento", não como erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { motivoDoErro } from "@/lib/flows/erro";
import { loadFlowGraph, nextNode } from "@/lib/flows/graph";
import { executeActionNode } from "@/lib/flows/nodes/action";
import { executeConditionNode } from "@/lib/flows/nodes/condition";
import { executeDelayNode } from "@/lib/flows/nodes/delay";
import { casarRespostaDeBotao, executeMessageNode } from "@/lib/flows/nodes/message";
import { executeWebhookNode } from "@/lib/flows/nodes/webhook";
import type {
  FlowExecutionRow,
  FlowNodeCtx,
  FlowNodeRow,
  MessageNodeConfig,
  NodeOutcome,
} from "@/lib/flows/types";
import { logger } from "@/lib/logger";

const MAX_STEPS_PER_RUN = 50;

async function fetchExecution(admin: SupabaseClient, executionId: string): Promise<FlowExecutionRow | null> {
  const { data } = await admin.from("flow_executions").select("*").eq("id", executionId).maybeSingle();
  return (data as FlowExecutionRow | null) ?? null;
}

async function fetchContact(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function recordEvent(
  admin: SupabaseClient,
  execution: FlowExecutionRow,
  nodeId: string | null,
  eventType: "entered" | "completed" | "failed" | "waiting" | "resumed" | "skipped",
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.from("flow_execution_events").insert({
    organization_id: execution.organization_id,
    execution_id: execution.id,
    node_id: nodeId,
    event_type: eventType,
    payload,
  });
  if (error) logger.error("[flows.engine] flow_execution_events insert failed", { error: error.message });
}

function buildEventRow(execution: FlowExecutionRow): EventRow {
  return {
    id: execution.trigger_event_id ?? execution.id,
    organization_id: execution.organization_id,
    event_type: "flow.execution",
    entity_kind: "contact",
    entity_id: execution.contact_id,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function buildNodeCtx(
  admin: SupabaseClient,
  execution: FlowExecutionRow,
  serviceBoundaries: Map<string, Promise<ServiceBoundary>>,
): FlowNodeCtx {
  return {
    admin,
    organizationId: execution.organization_id,
    ruleId: execution.id,
    ruleName: `flow:${execution.flow_id}`,
    event: buildEventRow(execution),
    context: execution.context,
    requestId: `flow:${execution.id}`,
    serviceBoundaries,
  };
}

async function runNode(ctx: FlowNodeCtx, node: FlowNodeRow): Promise<NodeOutcome> {
  switch (node.type) {
    case "TRIGGER":
      // Nó de entrada: não executa nada, só marca por onde o flow começa.
      return { kind: "advance" };
    case "MESSAGE":
      return executeMessageNode(ctx, node.config);
    case "CONDITION":
      return executeConditionNode(ctx, node.config);
    case "ACTION":
      return executeActionNode(ctx, node.config);
    case "DELAY":
      return executeDelayNode(node.config);
    case "WEBHOOK":
      return executeWebhookNode(ctx, node.config);
    case "END":
      return { kind: "end" };
    default:
      return { kind: "failed", error: `unknown_node_type:${node.type}` };
  }
}

/**
 * Roda a execução a partir do `current_node_id` até parar por: fim do flow,
 * espera (botão ou delay), falha, ou teto de passos (proteção contra ciclo
 * mal montado no canvas — nunca trava o worker, devolve `failed`).
 */
export async function runExecutionForward(admin: SupabaseClient, executionId: string): Promise<void> {
  let execution = await fetchExecution(admin, executionId);
  if (!execution || execution.status !== "running") return;

  // A organização vem da EXECUÇÃO, nunca de parâmetro do chamador: é ela que
  // recorta o grafo no service role (ver o cabeçalho de lib/flows/graph.ts).
  const graph = await loadFlowGraph(admin, execution.organization_id, execution.flow_id);
  const serviceBoundaries = new Map<string, Promise<ServiceBoundary>>();

  for (let step = 0; step < MAX_STEPS_PER_RUN; step++) {
    const node = execution.current_node_id ? graph.nodesById.get(execution.current_node_id) : null;
    if (!node) {
      await finish(admin, execution, { status: "failed", last_error: "orphan_node" });
      return;
    }

    await recordEvent(admin, execution, node.id, "entered");
    const ctx = buildNodeCtx(admin, execution, serviceBoundaries);
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runNode(ctx, node);
    // ACTION/CONDITION podem ter enriquecido ctx.context (ex.: update_custom_field) —
    // o snapshot persistido precisa refletir isso para os nós seguintes.
    execution.context = ctx.context;

    if (outcome.kind === "failed") {
      await recordEvent(admin, execution, node.id, "failed", { error: outcome.error });
      await finish(admin, execution, { status: "failed", last_error: outcome.error });
      return;
    }
    if (outcome.kind === "end") {
      await recordEvent(admin, execution, node.id, "completed");
      await finish(admin, execution, { status: "completed" });
      return;
    }
    if (outcome.kind === "wait_button") {
      await recordEvent(admin, execution, node.id, "waiting", { waiting_for: "button_reply" });
      await persist(admin, execution, {
        status: "waiting",
        waiting_for: "button_reply",
        waiting_node_id: node.id,
        current_node_id: node.id,
      });
      return;
    }
    if (outcome.kind === "wait_delay") {
      await recordEvent(admin, execution, node.id, "waiting", { waiting_for: "delay", until: outcome.until });
      await persist(admin, execution, {
        status: "waiting",
        waiting_for: "delay",
        waiting_node_id: node.id,
        current_node_id: node.id,
        next_execution_at: outcome.until,
      });
      return;
    }

    // advance
    const next = nextNode(graph, node.id, outcome.handle);
    await recordEvent(admin, execution, node.id, "completed");
    if (!next) {
      await finish(admin, execution, { status: "completed" });
      return;
    }
    execution = { ...execution, current_node_id: next.id };
    // Persiste o passo a cada nó — se o processo morrer no meio de um flow
    // longo, a retomada (worker/reply handler) parte do último nó concluído,
    // não do início.
    // eslint-disable-next-line no-await-in-loop
    await persist(admin, execution, { current_node_id: next.id });
  }

  await finish(admin, execution, { status: "failed", last_error: "max_steps_exceeded" });
}

async function persist(
  admin: SupabaseClient,
  execution: FlowExecutionRow,
  patch: Partial<FlowExecutionRow>,
): Promise<void> {
  const { error } = await admin
    .from("flow_executions")
    .update({ ...patch, context: execution.context, updated_at: new Date().toISOString() })
    .eq("id", execution.id);
  if (error) logger.error("[flows.engine] flow_executions update failed", { error: error.message, id: execution.id });
}

async function finish(
  admin: SupabaseClient,
  execution: FlowExecutionRow,
  patch: { status: "completed" | "failed"; last_error?: string },
): Promise<void> {
  await admin
    .from("flow_executions")
    .update({
      status: patch.status,
      last_error: patch.last_error ?? null,
      context: execution.context,
      waiting_for: null,
      waiting_node_id: null,
      next_execution_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", execution.id);
}

export interface StartFlowResult {
  ok: boolean;
  executionId?: string;
  reason?: "already_active" | "no_entry_node" | "insert_failed";
}

/**
 * Inicia uma execução para `contactId`. O nó de entrada é o (único) nó
 * TRIGGER do flow — quem valida que existe exatamente um é a API ao salvar o
 * grafo; aqui só se pega o primeiro.
 */
export async function startFlowExecution(
  admin: SupabaseClient,
  params: {
    organizationId: string;
    flowId: string;
    contactId: string;
    triggerEventId?: string | null;
  },
): Promise<StartFlowResult> {
  const graph = await loadFlowGraph(admin, params.organizationId, params.flowId);
  const entry = [...graph.nodesById.values()].find((n) => n.type === "TRIGGER");
  if (!entry) return { ok: false, reason: "no_entry_node" };

  const contact = await fetchContact(admin, params.organizationId, params.contactId);
  const context = { contact: contact ?? { id: params.contactId } };

  const { data, error } = await admin
    .from("flow_executions")
    .insert({
      organization_id: params.organizationId,
      flow_id: params.flowId,
      contact_id: params.contactId,
      status: "running",
      current_node_id: entry.id,
      context,
      trigger_event_id: params.triggerEventId ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { ok: false, reason: "already_active" };
    logger.error("[flows.engine] flow_executions insert failed", { error: error.message });
    return { ok: false, reason: "insert_failed" };
  }
  if (!data) return { ok: false, reason: "insert_failed" };

  await runExecutionForward(admin, data.id as string);
  return { ok: true, executionId: data.id as string };
}

/** Retomada por resposta de botão (reply.handler.ts). */
export async function resumeWithButtonReply(
  admin: SupabaseClient,
  execution: FlowExecutionRow,
  replyText: string,
): Promise<{ matched: boolean }> {
  if (execution.status !== "waiting" || execution.waiting_for !== "button_reply" || !execution.waiting_node_id) {
    return { matched: false };
  }
  const graph = await loadFlowGraph(admin, execution.organization_id, execution.flow_id);
  const node = graph.nodesById.get(execution.waiting_node_id);
  if (!node) return { matched: false };

  const index = casarRespostaDeBotao(node.config as MessageNodeConfig, replyText);
  if (index === null) return { matched: false };

  // Avança PARA ALÉM do nó que perguntou antes de retomar o laço — senão
  // runExecutionForward reexecutaria este mesmo nó (reenviando a pergunta em
  // vez de seguir o caminho escolhido).
  const next = nextNode(graph, node.id, `button:${index}`);
  await recordEvent(admin, execution, node.id, "resumed", { reply: replyText, option_index: index });
  await admin
    .from("flow_executions")
    .update({
      status: next ? "running" : "completed",
      waiting_for: null,
      waiting_node_id: null,
      current_node_id: next?.id ?? node.id,
      completed_at: next ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", execution.id);

  if (next) await runExecutionForward(admin, execution.id);
  return { matched: true };
}

/** Retomada pelo relógio do DELAY (cron/flow-worker). */
export async function resumeWithDelay(admin: SupabaseClient, execution: FlowExecutionRow): Promise<void> {
  if (execution.status !== "waiting" || execution.waiting_for !== "delay" || !execution.waiting_node_id) return;
  const graph = await loadFlowGraph(admin, execution.organization_id, execution.flow_id);
  const next = nextNode(graph, execution.waiting_node_id, null);
  await recordEvent(admin, execution, execution.waiting_node_id, "resumed", {});
  await admin
    .from("flow_executions")
    .update({
      status: next ? "running" : "completed",
      waiting_for: null,
      waiting_node_id: null,
      next_execution_at: null,
      claimed_until: null,
      current_node_id: next?.id ?? execution.waiting_node_id,
      completed_at: next ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", execution.id);
  if (next) await runExecutionForward(admin, execution.id);
}

export interface FlowWorkerTickSummary {
  claimed: number;
  resumed: number;
  failed: number;
  claim_falhou?: boolean;
}

/** Relógio do nó DELAY — chamado pelo cron `app/api/v1/cron/flow-worker`. */
export async function runFlowWorkerTick(
  admin: SupabaseClient,
  opts: { limit?: number; leaseSeconds?: number } = {},
): Promise<FlowWorkerTickSummary> {
  const { data, error } = await admin.rpc("fn_claim_due_flow_executions", {
    p_limit: opts.limit ?? 25,
    p_lease_seconds: opts.leaseSeconds ?? 120,
  });
  if (error) {
    logger.error("[flows.engine] fn_claim_due_flow_executions failed", { error: error.message });
    return { claimed: 0, resumed: 0, failed: 0, claim_falhou: true };
  }
  const rows = (data ?? []) as FlowExecutionRow[];
  let resumed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await resumeWithDelay(admin, row);
      resumed++;
    } catch (err) {
      failed++;
      logger.error("[flows.engine] resumeWithDelay threw", {
        execution_id: row.id,
        error: motivoDoErro(err),
      });
    }
  }
  return { claimed: rows.length, resumed, failed };
}
