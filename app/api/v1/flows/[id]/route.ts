/**
 * GET    /api/v1/flows/[id] — flow + nós + arestas (para abrir o canvas).
 * PATCH  /api/v1/flows/[id] — atualiza campos (inclui `status` — switch da UI).
 * DELETE /api/v1/flows/[id] — remove o flow (cascade leva nós/arestas/execuções).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { problemasParaAtivar, type NoParaValidar } from "@/lib/flows/validacao";
import { updateFlowSchema } from "@/lib/schemas/flows";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const [{ data: flow, error: flowErr }, { data: nodes, error: nodesErr }, { data: edges, error: edgesErr }] =
    await Promise.all([
      supabase.from("flows").select("*").eq("id", id).eq("organization_id", activeOrg.orgId).maybeSingle(),
      supabase.from("flow_nodes").select("*").eq("flow_id", id).eq("organization_id", activeOrg.orgId),
      supabase.from("flow_edges").select("*").eq("flow_id", id).eq("organization_id", activeOrg.orgId),
    ]);
  if (flowErr) return fail("internal_error", flowErr.message, 500, { requestId });
  if (!flow) return fail("not_found", t("Flow não encontrado."), 404, { requestId });
  if (nodesErr) return fail("internal_error", nodesErr.message, 500, { requestId });
  if (edgesErr) return fail("internal_error", edgesErr.message, 500, { requestId });

  return ok({ ...flow, nodes: nodes ?? [], edges: edges ?? [] }, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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
  const parsed = updateFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, { requestId, details: parsed.error.flatten() });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("flows")
    .select("id, trigger_type, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Flow não encontrado."), 404, { requestId });

  // LIGAR é o momento de cobrar o flow completo — não o de rascunhar. A partir
  // daqui entra contato de verdade, e o que estiver pela metade falha COM ELE
  // DENTRO: a execução para no meio, o motivo fica num `last_error` que ninguém
  // abre, e para o cliente simplesmente não chegou nada.
  //
  // A regra mora em `lib/flows/validacao.ts` e cobre o gatilho E os passos —
  // o caso que a motivou é o nó de mensagem em modo "fora da janela de 24h" sem
  // template, que ativava sem reclamar e morria no primeiro disparo.
  if (parsed.data.status === "active") {
    const { data: nosDoFlow } = await supabase
      .from("flow_nodes")
      .select("id, type, label, config")
      .eq("flow_id", id)
      .eq("organization_id", activeOrg.orgId);

    const problemas = problemasParaAtivar(
      (parsed.data.trigger_type ?? existing.trigger_type) as string,
      (parsed.data.trigger_config ?? existing.trigger_config ?? {}) as Record<string, unknown>,
      (nosDoFlow ?? []) as NoParaValidar[],
    );
    if (problemas.length > 0) {
      return fail("invalid_request", problemas.map((p) => t(p)).join(" "), 422, {
        requestId,
        details: problemas.map((p) => ({ path: "flow", message: t(p) })),
      });
    }
  }

  // `organization_id` explícito também na ESCRITA, e não só na leitura de
  // posse acima: a RLS já barraria o cross-tenant (este é o client de sessão),
  // mas a doutrina do repo é filtrar em toda query — e as rotas irmãs
  // (broadcasts/[id]) filtram em todas. Uma exceção aqui é a que vira regra
  // no próximo arquivo copiado daqui.
  const { data: updated, error: updErr } = await supabase
    .from("flows")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("*")
    .single();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "flows.updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "flow",
    resourceId: id,
    requestId,
    metadata: parsed.data,
  });

  return ok(updated, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("flows")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Flow não encontrado."), 404, { requestId });

  const { error: delErr } = await supabase
    .from("flows")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "flows.deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "flow",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}
