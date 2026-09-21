/**
 * GET /api/v1/flows/[id]/executions — aba Atividade: últimas execuções do
 * flow, com o contato e o nó atual/onde parou.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: flow, error: flowErr } = await supabase
    .from("flows")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (flowErr) return fail("internal_error", flowErr.message, 500, { requestId });
  if (!flow) return fail("not_found", t("Flow não encontrado."), 404, { requestId });

  const { data, error } = await supabase
    .from("flow_executions")
    .select(
      "id, status, waiting_for, current_node_id, last_error, started_at, updated_at, completed_at, contacts:contact_id(id, name, display_name, phone_number)",
    )
    .eq("flow_id", id)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
