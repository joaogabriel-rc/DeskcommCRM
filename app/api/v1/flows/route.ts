/**
 * GET  /api/v1/flows — lista os flows da org ativa.
 * POST /api/v1/flows — cria um flow (nasce `draft`, com o nó TRIGGER já
 *   plantado — sem ele o canvas abriria vazio e o usuário não saberia por
 *   onde começar). O GATILHO é escolhido DENTRO do construtor, no nó
 *   "Quando…": sem ele no corpo, o flow nasce com `trigger_type` nulo
 *   (rascunho, migration 0393) e só pode ser ativado depois de escolhido.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { FLOW_TRIGGERS } from "@/lib/flows/triggers";
import { createFlowSchema } from "@/lib/schemas/flows";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("flows")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    // O fluxo de um disparo (0399) é do disparo: aparece no editor do disparo,
    // nunca na lista de Automações.
    .is("broadcast_id", null)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
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
  const parsed = createFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, { requestId, details: parsed.error.flatten() });
  }

  const triggerType = parsed.data.trigger_type ?? null;
  const triggerConfig = triggerType ? parsed.data.trigger_config : {};

  const supabase = await createClient();
  const { data: created, error: insErr } = await supabase
    .from("flows")
    .insert({
      organization_id: activeOrg.orgId,
      created_by_user_id: user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
    })
    .select("*")
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "flow_insert_failed", 500, { requestId });
  }

  // Nó de entrada plantado na criação — o canvas sempre abre com o "Quando…"
  // no lugar (a UI monta o resto por cima dele). Sem gatilho escolhido, o nó
  // nasce sem `trigger_type` e a tela mostra "+ Novo gatilho"; trocar o
  // gatilho pela tela reescreve este nó.
  const { error: nodeErr } = await supabase.from("flow_nodes").insert({
    organization_id: activeOrg.orgId,
    flow_id: created.id,
    type: "TRIGGER",
    label: triggerType ? FLOW_TRIGGERS[triggerType].label : "Quando…",
    config: triggerType ? { trigger_type: triggerType, config: triggerConfig } : { config: {} },
    position_x: 80,
    position_y: 80,
  });
  if (nodeErr) {
    return fail("internal_error", nodeErr.message, 500, { requestId });
  }

  void audit({
    action: "flows.created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "flow",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name, trigger_type: triggerType },
  });

  return ok(created, { requestId, status: 201 });
}
