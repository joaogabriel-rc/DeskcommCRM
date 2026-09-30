import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET|POST /api/v1/channels/official/sincronizacao — a sincronização do app
 * WhatsApp Business num número em coexistência (Fase 2.0, migration 0495).
 *
 * GET devolve o estado: prazo de 24h, e, por tipo (contatos, histórico), se foi
 * pedido, o `request_id` da Meta, quando o primeiro payload chegou e o erro.
 *
 * POST pede — ou tenta de novo o que falhou — dentro do prazo. É o caminho do
 * número que já estava conectado quando esta fase entrou; conexões novas já pedem
 * sozinhas ao concluir o Cadastro Incorporado. A regra (ordem, reserva, prazo,
 * uma vez por tipo) mora em `lib/channels/meta/sincronizacao.ts`, não aqui.
 *
 * A organização vem da SESSÃO, nunca do corpo — o POST nem lê corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerSincronizacao, solicitarSincronizacaoDoApp } from "@/lib/channels/meta/sincronizacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_sync" });
  if (!authz.ok) return authz.response;

  try {
    return ok(await lerSincronizacao(createAdminClient(), authz.org.orgId));
  } catch (err) {
    logger.error("[meta.sincronizacao] leitura do estado falhou", {
      requestId,
      organization_id: authz.org.orgId,
      erro: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return fail("internal_error", "sync_state_unavailable", 500, { requestId });
  }
}

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_sync" });
  if (!authz.ok) return authz.response;
  const organizationId = authz.org.orgId;

  let desfecho: Awaited<ReturnType<typeof solicitarSincronizacaoDoApp>>;
  try {
    desfecho = await solicitarSincronizacaoDoApp(createAdminClient(), { organizationId, requestId });
  } catch (err) {
    logger.error("[meta.sincronizacao] pedido falhou", {
      requestId,
      organization_id: organizationId,
      erro: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return fail("internal_error", "sync_request_failed", 500, { requestId });
  }

  if (!desfecho.ok) {
    return fail("invalid_request", desfecho.motivo, 422, { requestId, details: { motivo: desfecho.motivo } });
  }

  const canalId = desfecho.situacao.disponivel ? desfecho.situacao.channelSessionId : null;
  void audit({
    action: "channel.app_sync_requested",
    actorUserId: authz.user.id,
    organizationId,
    resourceType: "channel_session",
    resourceId: canalId,
    requestId,
    metadata: { via: "pagina_do_canal", contatos: desfecho.contatos, historico: desfecho.historico },
  });

  // 200 mesmo quando a Meta recusou um tipo: a TENTATIVA foi feita e o desfecho
  // é estado (com motivo), que a tela mostra.
  return ok({ contatos: desfecho.contatos, historico: desfecho.historico, situacao: desfecho.situacao });
}
