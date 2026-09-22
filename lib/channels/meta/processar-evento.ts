/**
 * O que as DUAS rotas de webhook da Meta fazem igual: conferir a entrega e
 * processar cada evento para uma sessão já resolvida.
 *
 * `/api/v1/webhooks/meta` (universal) e `/api/v1/webhooks/meta/[token]`
 * (compatibilidade) diferem só em COMO descobrem a sessão dona do evento — pelo
 * número no payload assinado ou pelo token no caminho. O resto mora aqui para as
 * duas não divergirem.
 */
import { appDaMeta } from "@/lib/channels/meta/app";
import { lerEnvelopeMeta } from "@/lib/channels/meta/envelope";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { MetaWebhookSession } from "@/lib/channels/meta/session";
import { parseMetaWebhook, verifyMetaSignature, type MetaWebhookEvent } from "@/lib/channels/meta/webhook";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type LeituraDaEntrega =
  | { ok: true; eventos: MetaWebhookEvent[] }
  | { ok: false; status: 400 | 401; codigo: string; mensagem: string; detalhes?: unknown };

/**
 * Confere a assinatura e o contrato do corpo, e devolve os eventos.
 *
 * Assinatura HMAC-SHA256 com o App Secret da INSTALAÇÃO (`appDaMeta()`: banco
 * primeiro, `.env` como piso). É ela que autoriza o endpoint universal a confiar
 * no `phone_number_id` do corpo: sem assinatura válida, nada do corpo é lido.
 *
 * 400 para corpo fora do contrato, e não 200: o 200 generoso das rotas existe para
 * EVENTO QUE NÃO NOS INTERESSA; payload fora do contrato é o fio ter mudado, e
 * ninguém pode descobrir isso tarde. Ver `lib/channels/meta/envelope.ts`.
 */
export async function lerEntregaDaMeta(
  rawBody: string,
  assinatura: string | null,
  requestId: string,
): Promise<LeituraDaEntrega> {
  const { appSecret } = await appDaMeta();
  if (!verifyMetaSignature(rawBody, assinatura, appSecret ?? "")) {
    return { ok: false, status: 401, codigo: "unauthorized", mensagem: "invalid_signature" };
  }

  const leitura = lerEnvelopeMeta(rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, status: 400, codigo: "invalid_request", mensagem: "invalid_json" };
    }
    logger.error("[meta.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      campos: leitura.campos,
    });
    return {
      ok: false,
      status: 400,
      codigo: "validation_failed",
      mensagem: "payload fora do contrato do canal",
      detalhes: { campos: leitura.campos },
    };
  }

  return { ok: true, eventos: parseMetaWebhook(leitura.envelope) };
}

/**
 * Processa UM evento para a sessão dona dele. Toda escrita leva o
 * `organization_id` da sessão — nunca do corpo.
 *
 * Devolve o desfecho da ingestão de mensagem recebida (vai para `outcomes` na
 * resposta), `"waba_divergente"` quando o evento não é desta sessão, e `null` para
 * os demais eventos, que não têm desfecho próprio.
 */
export async function processarEventoDaMeta(
  admin: Admin,
  e: MetaWebhookEvent,
  sessao: MetaWebhookSession,
  agora: string,
): Promise<string | null> {
  // O evento chega carimbado com a WABA; se não for a desta sessão, não é dela.
  if (sessao.wabaId && e.wabaId && e.wabaId !== sessao.wabaId) return "waba_divergente";

  if (e.kind === "inbound_message") {
    // Mensagem do contato vira linha no inbox, move lead, acorda o agente e
    // carimba `last_inbound_at` — que é o que ABRE a janela de 24h.
    const r = await ingestMetaInbound(admin, e, { organizationId: sessao.organizationId });
    if (r.status === "failed" || r.status === "no_session") {
      // 2xx continua (a Meta re-entregaria em loop), mas a falha NÃO fica muda.
      logger.error("[meta.ingest] inbound não ingerido", {
        status: r.status,
        reason: r.status === "failed" ? r.reason : undefined,
        external_id: e.externalId,
        phone_number_id: e.phoneNumberId,
        organization_id: sessao.organizationId,
      });
    }
    return r.status;
  }

  if (e.kind === "template_status") {
    await admin
      .from("meta_templates")
      .update({ status: e.event, rejected_reason: e.reason, updated_at: agora })
      .eq("organization_id", sessao.organizationId)
      .eq("waba_id", e.wabaId)
      .eq("name", e.templateName)
      .eq("language", e.templateLanguage);
    return null;
  }

  await admin
    .from("messages")
    .update({ status: e.status === "failed" ? "failed" : "sent", updated_at: agora })
    .eq("organization_id", sessao.organizationId)
    .eq("external_id", e.externalId);
  return null;
}
