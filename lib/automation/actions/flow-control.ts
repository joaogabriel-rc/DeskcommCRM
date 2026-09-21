/**
 * Ações de CONTROLE DE FLOW: `start_flow` e `stop_flow`.
 *
 * ═══ Import dinâmico, e o porquê ═══
 *
 * O motor do flow importa o registry de ações (nó ACTION), e esta ação precisa
 * do motor: importar no topo fecharia um ciclo em tempo de carga do módulo.
 * `await import()` dentro do executor quebra o ciclo — a dependência passa a
 * existir só na hora da chamada, que é quando ela é verdade.
 *
 * ═══ start_flow não é recursão livre ═══
 *
 * O flow iniciado é uma execução NOVA, com a idempotência de sempre (índice
 * único por flow+contato em voo): um flow que chama a si mesmo não empilha
 * execuções, ele bate no 23505 e vira no-op. O teto de passos por rodada
 * (`MAX_STEPS_PER_RUN`) segue valendo dentro de cada execução.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function iniciar(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const flowId = typeof config.flow_id === "string" ? config.flow_id : null;
  if (!flowId) return { type: "start_flow", status: "failed", error: "missing_flow_id" };
  const contact = ctx.context.contact as { id?: string } | undefined;
  if (!contact?.id) return { type: "start_flow", status: "skipped", detail: { reason: "no_contact" } };

  // O flow alvo tem que ser DESTA organização — o admin client bypassa RLS, e
  // um id colado de outra instalação não pode virar execução aqui.
  const { data: alvo } = await ctx.admin
    .from("flows")
    .select("id, status")
    .eq("id", flowId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!alvo) return { type: "start_flow", status: "failed", error: "flow_not_found" };
  if ((alvo as { status?: string }).status !== "active") {
    return { type: "start_flow", status: "skipped", detail: { reason: "flow_inactive" } };
  }

  const { startFlowExecution } = await import("@/lib/flows/engine");
  const resultado = await startFlowExecution(ctx.admin, {
    organizationId: ctx.organizationId,
    flowId,
    contactId: contact.id,
    triggerEventId: typeof ctx.event.id === "string" ? ctx.event.id : null,
  });
  if (!resultado.ok && resultado.reason !== "already_active") {
    return { type: "start_flow", status: "failed", error: resultado.reason ?? "start_failed" };
  }
  return {
    type: "start_flow",
    status: "success",
    detail: { flow_id: flowId, execution_id: resultado.executionId ?? null, ja_em_andamento: !resultado.ok },
  };
}

/**
 * Cancela execuções EM VOO do contato. Sem `flow_id`, cancela todas — inclusive
 * a que está rodando esta ação, que é o caso de uso ("pare tudo e entregue para
 * um humano"). O motor não se importa: ele já leu o nó e vai persistir o
 * desfecho por cima; o que muda é que a PRÓXIMA retomada não acha execução viva.
 */
async function parar(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const contact = ctx.context.contact as { id?: string } | undefined;
  if (!contact?.id) return { type: "stop_flow", status: "skipped", detail: { reason: "no_contact" } };
  const flowId = typeof config.flow_id === "string" ? config.flow_id : null;

  let query = ctx.admin
    .from("flow_executions")
    .update({
      status: "cancelled",
      waiting_for: null,
      waiting_node_id: null,
      next_execution_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contact.id)
    .in("status", ["running", "waiting"]);
  if (flowId) query = query.eq("flow_id", flowId);

  const { data, error } = await query.select("id");
  if (error) return { type: "stop_flow", status: "failed", error: error.message };
  return { type: "stop_flow", status: "success", detail: { canceladas: (data ?? []).length } };
}

registerAction({ type: "start_flow", execute: iniciar });
registerAction({ type: "stop_flow", execute: parar });
