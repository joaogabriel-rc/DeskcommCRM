import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowEdgeRow, FlowNodeRow } from "@/lib/flows/types";

export interface FlowGraph {
  nodesById: Map<string, FlowNodeRow>;
  edgesBySource: Map<string, FlowEdgeRow[]>;
}

/**
 * Carrega o desenho de um flow para o motor executar.
 *
 * ═══ `organizationId` É OBRIGATÓRIO, e a razão é uma falha real ═══
 *
 * Esta função roda com o ADMIN client (service role), que BYPASSA RLS. Até a
 * auditoria desta branch ela filtrava só por `flow_id`:
 *
 *     admin.from("flow_nodes").select("*").eq("flow_id", flowId)
 *
 * Isso é o anti-pattern nº 10 do CLAUDE.md ("service role sem filtrar
 * organization_id manualmente") e era a segunda metade de uma cadeia
 * explorável. A primeira metade estava em `fn_flow_replace_graph`, que
 * aceitava `p_flow_id` de uma organização e `p_organization_id` de outra sem
 * conferir que os dois casavam — a RLS de `flow_nodes` só valida a COLUNA
 * `organization_id` da linha sendo escrita, nunca o dono do `flow_id` que ela
 * referencia.
 *
 * Juntas: um manager de qualquer organização podia chamar a RPC direto pelo
 * PostgREST (ela é `grant execute ... to authenticated`), anexar nós e arestas
 * ao flow de OUTRA organização com o `organization_id` dele próprio — e o
 * motor, lendo só por `flow_id` com service role, carregaria esses nós dentro
 * da execução da vítima. Um nó WEBHOOK injetado assim exfiltraria o contato
 * alheio; um nó MESSAGE mandaria WhatsApp no número da vítima.
 *
 * As duas pontas foram fechadas, e as duas continuam necessárias: a função SQL
 * recusa o par (flow, org) que não existe, e esta função aqui recusa, na
 * leitura, qualquer linha que não seja da organização da execução. Fechar só
 * uma delas deixaria a outra metade de pé para a próxima entrada.
 *
 * O parâmetro é POSICIONAL e obrigatório de propósito: opcional, o primeiro
 * chamador distraído reabriria o buraco sem o typecheck dizer nada.
 */
export async function loadFlowGraph(
  admin: SupabaseClient,
  organizationId: string,
  flowId: string,
): Promise<FlowGraph> {
  const [{ data: nodes }, { data: edges }] = await Promise.all([
    admin.from("flow_nodes").select("*").eq("organization_id", organizationId).eq("flow_id", flowId),
    admin.from("flow_edges").select("*").eq("organization_id", organizationId).eq("flow_id", flowId),
  ]);
  const nodesById = new Map<string, FlowNodeRow>();
  for (const n of (nodes ?? []) as FlowNodeRow[]) nodesById.set(n.id, n);
  const edgesBySource = new Map<string, FlowEdgeRow[]>();
  for (const e of (edges ?? []) as FlowEdgeRow[]) {
    const list = edgesBySource.get(e.source_node_id) ?? [];
    list.push(e);
    edgesBySource.set(e.source_node_id, list);
  }
  return { nodesById, edgesBySource };
}

/**
 * Próximo nó a partir de `nodeId`, seguindo a aresta cujo `source_handle`
 * bate com `handle` (null = saída única/default). Nó com mais de uma aresta
 * default é erro de montagem — pega a primeira, determinística por id.
 */
export function nextNode(graph: FlowGraph, nodeId: string, handle: string | null | undefined): FlowNodeRow | null {
  const edges = graph.edgesBySource.get(nodeId) ?? [];
  const match =
    edges.find((e) => (e.source_handle ?? null) === (handle ?? null)) ??
    (handle == null ? edges[0] : undefined);
  if (!match) return null;
  return graph.nodesById.get(match.target_node_id) ?? null;
}
