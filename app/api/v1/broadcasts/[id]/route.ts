/**
 * GET    /api/v1/broadcasts/[id] — o disparo, com o andamento.
 * PATCH  /api/v1/broadcasts/[id] — edita o rascunho ou aplica uma AÇÃO
 *   (agendar, pausar, retomar, cancelar).
 * DELETE /api/v1/broadcasts/[id] — apaga um disparo que ainda não começou.
 *
 * ── Agendar é onde a autorização acontece ───────────────────────────────────
 *
 * `acao: "agendar"` faz três coisas, nesta ordem e por esta razão:
 *
 *   1. resolve o público pela MESMA query da prévia (`listarPublico`);
 *   2. chama `fn_broadcast_materializar`, que ancora a fronteira de serviço de
 *      cada contato DENTRO do banco e cria a linha de destinatário;
 *   3. só então marca o disparo como `scheduled`.
 *
 * O passo 2 é o que torna o worker um executor e não um autorizador: ele nunca
 * cria permissão de falar com ninguém, só reconfere a que foi criada aqui,
 * no clique de uma pessoa (ver o cabeçalho de `lib/disparos/worker.ts`).
 *
 * ── O teto, e por que ele existe ────────────────────────────────────────────
 *
 * A materialização acontece dentro de um request HTTP. `fn_broadcast_materializar`
 * a faz em UMA chamada (não em N idas e voltas de rede), mas ainda assim há um
 * limite prático — e um limite explícito, com mensagem, é melhor que um timeout
 * de gateway no meio, que deixa metade do público materializado e nenhum
 * registro de onde parou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { listarPublico, resumoDoSegmento } from "@/lib/disparos/segmento";
import {
  atualizarDisparoSchema,
  porQueNaoPodeAgendar,
  segmentoSchema,
  mensagemDeDisparoSchema,
  type DisparoRow,
} from "@/lib/schemas/disparos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Quantos contatos um disparo alcança por vez. Não é limite do motor — o worker
 * processa qualquer fila — é o limite do gesto de MATERIALIZAR dentro de um
 * request. Acima disso a resposta manda estreitar o filtro, que é o que um
 * operador faria de qualquer jeito.
 */
const TETO_DE_PUBLICO = 5000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Disparo não encontrado.", 404, { requestId });

  // As últimas falhas, para a tela explicar o que deu errado em vez de mostrar
  // só um contador. `organization_id` no filtro por doutrina, mesmo com a RLS
  // já recortando: toda query que cruza tabela tenant-aware filtra explícito.
  const { data: falhas } = await supabase
    .from("broadcast_recipients")
    .select("id, status, error, sent_at, contacts(id, name, display_name, phone_number)")
    .eq("broadcast_id", id)
    .eq("organization_id", authz.org.orgId)
    .in("status", ["failed", "skipped"])
    .order("updated_at", { ascending: false })
    .limit(20);

  return ok({ ...(data as unknown as DisparoRow), problemas: falhas ?? [] }, { requestId });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const parsed = atualizarDisparoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados do disparo.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Disparo não encontrado.", 404, { requestId });
  const disparo = atual as unknown as DisparoRow;

  /* ── Edição do conteúdo ─────────────────────────────────────────────────── */
  if (!parsed.data.acao) {
    // Editar depois de materializado mudaria a mensagem de quem ainda não
    // recebeu e não de quem já recebeu — duas campanhas com o mesmo nome. Pausar
    // primeiro é o mesmo contrato do Flow ("editar exige pausar").
    if (disparo.status !== "draft" && disparo.status !== "paused") {
      return fail(
        "conflict",
        "Pause o disparo antes de editar — senão metade do público recebe uma mensagem e metade recebe outra.",
        409,
        { requestId },
      );
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.segment !== undefined) patch.segment = parsed.data.segment;
    if (parsed.data.message !== undefined) patch.message = parsed.data.message;
    if (parsed.data.scheduled_at !== undefined) patch.scheduled_at = parsed.data.scheduled_at ?? null;

    const { data, error } = await supabase
      .from("broadcasts")
      .update(patch)
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    if (error) return fail("internal_error", error.message, 500, { requestId });

    void audit({
      action: "broadcast.updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "broadcast",
      resourceId: id,
      requestId,
      metadata: { campos: Object.keys(patch) },
    });
    return ok(data as unknown as DisparoRow, { requestId });
  }

  /* ── Ações de ciclo de vida ─────────────────────────────────────────────── */
  const agora = new Date().toISOString();

  if (parsed.data.acao === "pausar") {
    if (disparo.status !== "running" && disparo.status !== "scheduled") {
      return fail("conflict", "Só dá para pausar um disparo agendado ou em andamento.", 409, { requestId });
    }
    const { data } = await supabase
      .from("broadcasts")
      .update({ status: "paused", next_run_at: null, claimed_until: null, updated_at: agora })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    void audit({
      action: "broadcast.updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "broadcast",
      resourceId: id,
      requestId,
      metadata: { acao: "pausar" },
    });
    return ok(data as unknown as DisparoRow, { requestId });
  }

  if (parsed.data.acao === "cancelar") {
    if (disparo.status === "completed" || disparo.status === "cancelled") {
      return fail("conflict", "Este disparo já terminou.", 409, { requestId });
    }
    const { data } = await supabase
      .from("broadcasts")
      .update({
        status: "cancelled",
        next_run_at: null,
        claimed_until: null,
        finished_at: agora,
        updated_at: agora,
      })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    void audit({
      action: "broadcast.updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "broadcast",
      resourceId: id,
      requestId,
      metadata: { acao: "cancelar", enviados: disparo.sent_count },
    });
    return ok(data as unknown as DisparoRow, { requestId });
  }

  if (parsed.data.acao === "retomar") {
    if (disparo.status !== "paused") {
      return fail("conflict", "Só um disparo pausado pode ser retomado.", 409, { requestId });
    }
    // `next_run_at = agora` faz o próximo tick pegá-lo. A fila de pendentes
    // continua onde estava — ninguém recebe de novo, pelo índice único.
    const { data } = await supabase
      .from("broadcasts")
      .update({ status: "running", next_run_at: agora, updated_at: agora })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    void audit({
      action: "broadcast.updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "broadcast",
      resourceId: id,
      requestId,
      metadata: { acao: "retomar" },
    });
    return ok(data as unknown as DisparoRow, { requestId });
  }

  /* ── agendar: o gesto de AUTORIZAÇÃO ────────────────────────────────────── */
  if (disparo.status !== "draft" && disparo.status !== "paused") {
    return fail("conflict", "Este disparo já foi agendado.", 409, { requestId });
  }

  const segmento = segmentoSchema.parse(disparo.segment ?? {});
  const mensagem = mensagemDeDisparoSchema.parse(disparo.message ?? {});
  const impedimento = porQueNaoPodeAgendar({ segment: segmento, message: mensagem });
  if (impedimento) return fail("validation_failed", impedimento, 422, { requestId });

  // O público sai do client da SESSÃO: a RLS de `contacts` recorta a
  // organização, então nenhum id de fora pode entrar na lista.
  const { contatos, erro } = await listarPublico(supabase, authz.org.orgId, segmento, {
    limite: TETO_DE_PUBLICO + 1,
    offset: 0,
  });
  if (erro) return fail("internal_error", erro, 500, { requestId });
  if (contatos.length === 0) {
    return fail("validation_failed", "Nenhum contato atende a esses critérios agora.", 422, { requestId });
  }
  if (contatos.length > TETO_DE_PUBLICO) {
    return fail(
      "validation_failed",
      `Este público passa de ${TETO_DE_PUBLICO} contatos. Estreite os critérios e faça em partes.`,
      422,
      { requestId },
    );
  }

  // Admin client SÓ AQUI, e com o `p_org` vindo da sessão autenticada (nunca do
  // corpo): `fn_broadcast_materializar` é `security definer` e precisa chamar
  // `fn_service_begin`, que é revogada de `authenticated`.
  const admin = createAdminClient();
  const { data: materializacao, error: matErr } = await admin.rpc("fn_broadcast_materializar", {
    p_broadcast: id,
    p_org: authz.org.orgId,
    p_contact_ids: contatos.map((c) => c.id),
  });
  if (matErr) return fail("internal_error", matErr.message, 500, { requestId });

  const quando = disparo.scheduled_at ?? agora;
  const { data, error } = await supabase
    .from("broadcasts")
    .update({
      status: "scheduled",
      scheduled_at: quando,
      next_run_at: quando,
      last_error: null,
      updated_at: agora,
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("*")
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "broadcast.scheduled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "broadcast",
    resourceId: id,
    requestId,
    metadata: {
      publico: contatos.length,
      segmento: resumoDoSegmento(segmento),
      quando,
      ...(materializacao as Record<string, unknown> | null),
    },
  });

  return ok(data as unknown as DisparoRow, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("broadcasts")
    .select("id, name, status, sent_count")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Disparo não encontrado.", 404, { requestId });

  // Um disparo que JÁ ENVIOU é histórico: apagá-lo levaria junto o registro de
  // quem recebeu o quê, que é a única prova de que a mensagem saiu. Cancele.
  if ((atual as { sent_count: number }).sent_count > 0) {
    return fail(
      "conflict",
      "Este disparo já enviou mensagens e não pode ser apagado — o registro de quem recebeu faz parte do histórico. Cancele-o.",
      409,
      { requestId },
    );
  }

  const { error } = await supabase
    .from("broadcasts")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "broadcast.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "broadcast",
    resourceId: id,
    requestId,
    metadata: { name: (atual as { name: string }).name },
  });

  return ok({ id }, { requestId });
}
