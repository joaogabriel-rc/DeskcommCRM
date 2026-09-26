/**
 * Ingestão do ECO do app WhatsApp Business — a mensagem que o dono mandou pelo
 * celular, num número conectado em coexistência (campo `smb_message_echoes`).
 *
 * É o equivalente oficial do caminho `fromMe` do canal por QR
 * (`handleOutboundFromUserPhone`, em `lib/waha/ingest.ts`), e segue as mesmas
 * decisões, pelos mesmos motivos:
 *
 *   - o contato é o DESTINATÁRIO (`to`); o número da empresa nunca vira contato,
 *     e o nome do perfil não é repassado (seria o da loja, não o do cliente);
 *   - a linha entra como `outbound` + `sent_via: "external_device"`, que é o que
 *     as métricas de atendimento por fora contam;
 *   - o número interno de avisos não vira atendimento;
 *   - a IA PAUSA nessa conversa (`pausarIaPorAtendimentoManual`), porque uma
 *     pessoa respondeu por fora do CRM — salvo quando a linha é eco de um envio
 *     nosso ainda em voo;
 *   - reentrega não duplica: `unique (organization_id, external_id)` → 23505 →
 *     `duplicate`, e a duplicata não pausa de novo nem audita de novo.
 *
 * O que NÃO faz, de propósito: `aplicarEfeitosPosEntrada` (nascer lead, acordar o
 * agente) é reação a mensagem do CLIENTE. O WAHA também não chama no `fromMe`.
 *
 * A organização vem de quem chama (a sessão dona do número, resolvida pela rota),
 * nunca do corpo; o número continua no filtro porque uma organização pode ter mais
 * de um número oficial.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import {
  ehNumeroInternoDeAviso,
  registrarMensagemIgnorada,
} from "@/lib/escalacao/numero-interno-de-aviso";
import { logger } from "@/lib/logger";

import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import type { ChannelTenantScope } from "../types";
import { previewOf, sessionByPhoneNumberId, type IngestOutcome } from "./ingest";
import type { EchoMessageEvent } from "./webhook";

type Admin = SupabaseClient;

/**
 * Quanto tempo um envio nosso pode ficar "em voo" antes de o eco deixar de ser
 * explicável por ele. O mesmo valor, e o mesmo raciocínio assimétrico, do canal
 * por QR: errar para o lado permissivo custa um minuto de IA sem pausar; errar
 * para o outro custa a IA muda.
 */
const JANELA_DO_ECO_MS = 60_000;

/**
 * O eco é de um envio que ESTE CRM acabou de fazer, e não de alguém no celular?
 *
 * Pela documentação da Meta a resposta é sempre "não" — o eco só existe para o
 * que saiu pelo app. A checagem fica mesmo assim, com a MESMA prova exigida pelo
 * canal por QR (linha nossa na mesma conversa, ainda sem `external_id`, mesmo
 * corpo, dentro da janela): se a Meta um dia ecoar um envio da Cloud API, a IA
 * não se cala por causa de uma mensagem que ela mesma mandou.
 */
async function ehEcoDeEnvioNosso(
  admin: Admin,
  organizationId: string,
  conversationId: string,
  e: EchoMessageEvent,
): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_DO_ECO_MS).toISOString();
  const { data, error } = await admin
    .from("messages")
    .select("id, body, type")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("sent_via", ["ai", "user", "automation", "system"])
    .is("external_id", null)
    .in("status", ["queued", "sending"])
    .gte("created_at", desde)
    .limit(20);

  // Falha de leitura não pode virar "é eco": na dúvida, pausa — é o desfecho
  // seguro do lado de quem está atendendo.
  if (error) return false;

  const corpo = (e.text ?? "").trim();
  for (const linha of (data ?? []) as Array<{ body: string | null; type: string | null }>) {
    if (e.type !== "text") {
      if ((linha.type ?? "text") !== "text") return true;
      continue;
    }
    if (corpo.length > 0 && (linha.body ?? "").trim() === corpo) return true;
  }
  return false;
}

export async function ingestMetaEcho(
  admin: Admin,
  e: EchoMessageEvent,
  dono: ChannelTenantScope,
): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try {
    sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "sessao_do_numero" };
  }
  if (!sessao) return { status: "no_session" };

  const orgId = sessao.organization_id;
  const telefone = `+${e.to.replace(/\D/g, "")}`;

  if (await ehNumeroInternoDeAviso(admin, orgId, { kind: "phone", phone: telefone, lid: null })) {
    await registrarMensagemIgnorada(admin, orgId, { direction: "outbound", sessionId: sessao.id });
    return { status: "ignored", reason: "numero_interno_de_aviso" };
  }

  const existente = await encontrarContatoPorTelefone(admin as never, orgId, e.to);
  const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonicalPhoneBR(telefone);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.to,
      // O perfil de um eco é o da EMPRESA: repassá-lo batizaria o cliente com o
      // nome da loja, e o `coalesce` da função congelaria o nome errado.
      p_notify: null,
    } as never,
  );
  if (erroContato || !contactId) {
    return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never,
  );
  if (erroConversa || !conversationId) {
    return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      channel_session_id: sessao.id,
      contact_id: contactId as string,
      direction: "outbound",
      status: "sent",
      sent_via: "external_device",
      type: e.type,
      body: e.type === "contact" ? (e.sharedContact?.name ?? e.text) : e.text,
      external_id: e.externalId,
      media_url: e.media ? `meta-media:${e.media.id}` : null,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: {
        origem: "whatsapp_business_app",
        ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}),
        ...(e.sharedContact ? { shared_contact: e.sharedContact } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  // 23505 = a Meta reentregando o mesmo eco. Nada mais a fazer: a primeira
  // entrega já carimbou a conversa e pausou a IA.
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: conversationId as string,
    direction: "outbound",
    preview: previewOf(e),
    at: e.sentAt.toISOString(),
    canal: "meta",
  });

  // Gravar a linha é tolerante; calar a IA é estrito — as duas decisões em
  // direções opostas, como no canal por QR (issue #519).
  if (!(await ehEcoDeEnvioNosso(admin, orgId, conversationId as string, e))) {
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: orgId,
      conversationId: conversationId as string,
      canal: "meta",
    });
  }

  await audit({
    action: "message.sent",
    organizationId: orgId,
    resourceType: "message",
    metadata: {
      conversation_id: conversationId as string,
      type: e.type,
      external_id: e.externalId,
      from_user_phone: true,
    },
  });

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (e.media && messageId) {
    const { error: erroPersistencia } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: conversationId as string },
      p_metadata: { source: "meta_webhook" },
      p_organization_id: orgId,
    } as never);
    if (erroPersistencia) {
      logger.warn("[meta.eco] pedido de persistência da mídia falhou", {
        organization_id: orgId,
        message_id: messageId,
        detalhe: erroPersistencia.message,
      });
    }
  }

  return { status: "ingested", messageId, conversationId: conversationId as string };
}
