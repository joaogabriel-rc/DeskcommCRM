/**
 * GET  /api/v1/broadcasts — os disparos da organização ativa.
 * POST /api/v1/broadcasts — cria um disparo (nasce `draft`, sem público
 *   materializado e sem nada agendado).
 *
 * O disparo nasce RASCUNHO e não sai daí sozinho. Materializar o público e
 * agendar são um gesto separado (PATCH com `acao: "agendar"`), porque é ali que
 * a autorização acontece — e autorização de mandar WhatsApp para 800 pessoas
 * não pode ser efeito colateral de "criar".
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarFluxoDoDisparo } from "@/lib/disparos/fluxo-do-disparo";
import { resumoDoSegmento } from "@/lib/disparos/segmento";
import { criarDisparoSchema, type DisparoRow } from "@/lib/schemas/disparos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  // O modo de cada um sai da existência do fluxo próprio (0399) — uma consulta
  // para a lista inteira, recortada pela organização.
  const { data: fluxos } = await supabase
    .from("flows")
    .select("broadcast_id")
    .eq("organization_id", authz.org.orgId)
    .not("broadcast_id", "is", null);
  const comFluxo = new Set(((fluxos ?? []) as Array<{ broadcast_id: string }>).map((f) => f.broadcast_id));
  return ok(
    ((data ?? []) as unknown as DisparoRow[]).map((d) => ({ ...d, modo: comFluxo.has(d.id) ? "fluxo" : "guiado" })),
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = criarDisparoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados do disparo.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("broadcasts")
    .insert({
      organization_id: authz.org.orgId,
      created_by_user_id: authz.user.id,
      name: parsed.data.name,
      segment: parsed.data.segment,
      message: parsed.data.message,
      scheduled_at: parsed.data.scheduled_at ?? null,
    })
    .select("*")
    .single();
  if (error || !data) return fail("internal_error", error?.message ?? "insert_failed", 500, { requestId });

  // Modo FLUXO: o disparo nasce com o fluxo PRÓPRIO dele (0399) — o operador
  // abre o construtor a partir do disparo e monta ali a mensagem e o resto.
  let fluxo: { id: string; status: string } | null = null;
  if (parsed.data.modo === "fluxo") {
    try {
      fluxo = await criarFluxoDoDisparo(supabase, {
        organizationId: authz.org.orgId,
        broadcastId: (data as unknown as DisparoRow).id,
        nomeDoDisparo: parsed.data.name,
        userId: authz.user.id,
      });
    } catch (err) {
      return fail("internal_error", err instanceof Error ? err.message : "flow_create_failed", 500, { requestId });
    }
  }

  void audit({
    action: "broadcast.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "broadcast",
    resourceId: (data as unknown as DisparoRow).id,
    requestId,
    metadata: {
      name: parsed.data.name,
      segmento: resumoDoSegmento(parsed.data.segment),
      modo: parsed.data.modo,
      ...(fluxo ? { flow_id: fluxo.id } : {}),
    },
  });

  return ok({ ...(data as unknown as DisparoRow), modo: parsed.data.modo, fluxo }, { requestId, status: 201 });
}
