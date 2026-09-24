/**
 * PUT /api/v1/flows/[id]/graph — substitui nós+arestas atomicamente
 * (fn_flow_replace_graph, migration 0388). O canvas manda o grafo inteiro a
 * cada save — mesma semântica do editor de follow-up (draft_graph).
 *
 * Exige exatamente 1 nó TRIGGER (é o ponto de entrada que o engine usa em
 * `startFlowExecution`) — 422 antes de tocar o banco. O gatilho DENTRO dele
 * pode estar vazio (rascunho); só não pode ser um gatilho inexistente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { FLOW_TRIGGERS } from "@/lib/flows/triggers";
import { replaceFlowGraphSchema } from "@/lib/schemas/flows";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = replaceFlowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, { requestId, details: parsed.error.flatten() });
  }

  const triggers = parsed.data.nodes.filter((n) => n.type === "TRIGGER");
  if (triggers.length !== 1) {
    return fail("invalid_request", t("O flow precisa de exatamente um gatilho."), 422, { requestId });
  }
  // O gatilho é EDITADO no canvas e LIDO pelo motor na linha do flow — as duas
  // verdades divergiriam na primeira troca de gatilho se o save não
  // projetasse uma na outra. O canvas é o editor; a linha é a projeção.
  //
  // Gatilho AUSENTE é rascunho e salva (migration 0393): o operador monta o
  // desenho antes de decidir o que o inicia, e cobrar o gatilho a cada save
  // faria o canvas não deixar salvar o próprio trabalho. Quem barra é a
  // ATIVAÇÃO (`lib/flows/validacao.ts`). Gatilho PRESENTE e inventado continua
  // recusado aqui — isso nunca é rascunho, é dado inválido.
  const cfgDoGatilho = triggers[0]!.config as { trigger_type?: unknown; config?: unknown };
  const bruto = cfgDoGatilho.trigger_type;
  let triggerType = typeof bruto === "string" && bruto.trim() ? bruto : null;
  if (bruto !== undefined && bruto !== null && bruto !== "" && (!triggerType || !(triggerType in FLOW_TRIGGERS))) {
    return fail("invalid_request", t("Escolha um gatilho válido para este flow."), 422, { requestId });
  }
  const triggerConfig =
    triggerType && cfgDoGatilho.config && typeof cfgDoGatilho.config === "object"
      ? (cfgDoGatilho.config as Record<string, unknown>)
      : {};
  const nodeIds = new Set(parsed.data.nodes.map((n) => n.id));
  for (const edge of parsed.data.edges) {
    if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id)) {
      return fail("invalid_request", t("Conexão aponta para um nó que não existe."), 422, { requestId });
    }
  }

  const supabase = await createClient();
  const { data: flow, error: flowErr } = await supabase
    .from("flows")
    .select("id, status, version, broadcast_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (flowErr) return fail("internal_error", flowErr.message, 500, { requestId });
  if (!flow) return fail("not_found", t("Flow não encontrado."), 404, { requestId });

  // O gatilho INTERNO (o do disparo, 0394) não se escolhe no canvas: o fluxo de
  // um disparo o mantém sempre, e um fluxo comum nunca o recebe. O nó é
  // projetado de volta, para o canvas e a linha não divergirem.
  if (flow.broadcast_id) {
    triggerType = "broadcast";
    triggers[0]!.config = { trigger_type: "broadcast", config: {} };
  } else if (triggerType && FLOW_TRIGGERS[triggerType as keyof typeof FLOW_TRIGGERS]?.interno) {
    return fail("invalid_request", t("Escolha um gatilho válido para este flow."), 422, { requestId });
  }

  // Editar o grafo de um flow ATIVO em voo é perigoso (execuções em andamento
  // apontam pra nós que podem sumir) — mesma trava que o design de automação
  // ramificada já previu para o caso irmão.
  if (flow.status === "active") {
    return fail(
      "flow_must_pause_to_edit_graph",
      t("Pause o flow antes de editar o canvas. Ative de novo depois de salvar."),
      409,
      { requestId },
    );
  }

  const { error: rpcErr } = await supabase.rpc("fn_flow_replace_graph", {
    p_flow_id: id,
    p_organization_id: activeOrg.orgId,
    p_nodes: parsed.data.nodes,
    p_edges: parsed.data.edges,
  });
  if (rpcErr) {
    // P0002 = a guarda da própria função: o par (flow, organização) não existe.
    // Por esta rota é inalcançável (a leitura acima já devolveu 404 nesse caso),
    // e é justamente por isso que o tratamento existe — a função é chamável
    // direto pelo PostgREST, e quem a chamar assim tem de receber a mesma
    // resposta que receberia aqui, nunca um 500 que parece falha do sistema.
    if (rpcErr.code === "P0002") {
      return fail("not_found", t("Flow não encontrado."), 404, { requestId });
    }
    return fail("internal_error", rpcErr.message, 500, { requestId });
  }

  // O gatilho do canvas vira a verdade que o motor lê, e a versão sobe: é o
  // número que a Atividade usa para explicar por qual desenho um contato passou.
  const { error: syncErr } = await supabase
    .from("flows")
    .update({
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      version: (flow.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (syncErr) return fail("internal_error", syncErr.message, 500, { requestId });

  void audit({
    action: "flows.graph_saved",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "flow",
    resourceId: id,
    requestId,
    metadata: {
      node_count: parsed.data.nodes.length,
      edge_count: parsed.data.edges.length,
      trigger_type: triggerType,
    },
  });

  return ok({ saved: true }, { requestId });
}
