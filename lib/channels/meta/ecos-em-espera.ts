/**
 * Ecos do app WhatsApp Business em espera — a quarentena do eco SUSPEITO
 * (migration 0496).
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 * Durante a sincronização do histórico, parte da MÍDIA histórica que a empresa
 * mandou pelo aplicativo chega pelo campo `smb_message_echoes` — o mesmo do eco
 * ao vivo. Medido numa reconexão: 38 mídias de dias antes viraram mensagem nova,
 * criaram contatos e conversas e pausaram a IA. No history guardado, cada uma
 * delas é um `media_placeholder` com `history_context.from_me = true` e o MESMO
 * wamid do eco; nenhuma mensagem do history é posterior ao onboarding.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *   1. PORTA DE SUSPEITA (aqui, no ingest): eco com `timestamp` anterior ao
 *      `meta_onboarding_em` do canal, com folga de relógio, é suspeito. Canal sem
 *      onboarding, ou eco dentro da folga, segue o caminho ao vivo de sempre.
 *   2. O suspeito é GUARDADO BRUTO em `meta_ecos_em_espera` — nenhum contato,
 *      conversa, mensagem, pausa ou evento de mensagem.
 *   3. A CLASSIFICAÇÃO DEFINITIVA é pelo wamid, depois, contra o history da MESMA
 *      janela (`fn_meta_ecos_correlacionar`) — ver
 *      `lib/channels/meta/resolver-ecos-em-espera.ts`. O timestamp nunca decide
 *      sozinho que um eco é histórico.
 *
 * Nada aqui importa history nem cria mensagem histórica: isso é do importador de
 * history, que ainda não existe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { IngestOutcome } from "./ingest";
import type { EchoMessageEvent } from "./webhook";

type Admin = SupabaseClient;

/** Vocabulário do CHECK `meta_ecos_em_espera.estado` (0496). */
export const ESTADOS_DO_ECO_EM_ESPERA = ["aguardando", "historico", "promovido", "duplicado"] as const;
export type EstadoDoEcoEmEspera = (typeof ESTADOS_DO_ECO_EM_ESPERA)[number];

/**
 * Folga de relógio entre o `timestamp` da Meta e o `meta_onboarding_em` gravado
 * pelo nosso relógio. Um eco dentro dela é tratado como ao vivo: se for mídia
 * histórica, o wamid é o mesmo do placeholder e o `unique (organization_id,
 * external_id)` impede a duplicata no importador — o custo do erro é limitado.
 */
export const FOLGA_DO_ONBOARDING_MS = 5 * 60 * 1000;

/**
 * O evento que acorda o resolvedor da janela: um pedaço de history foi guardado
 * (emitido por `guardarPayloadDeSincronizacao`, consumido por
 * `ecos-em-espera.handler.ts`). O eco que entra na quarentena NÃO o emite — ele
 * não é um pedaço de history; quem o decide, quando o history já veio antes, é a
 * próxima rodada do cron `meta-ecos-em-espera` (5 min).
 */
export const EVENTO_CHUNK_GUARDADO = "meta.historico.chunk_guardado";

/** A janela de um canal: organização, canal e o onboarding a que o eco pertence. */
export interface AlvoDosEcos {
  organizationId: string;
  channelSessionId: string;
  onboardingEm: string;
}

export type ClasseDoEco = "ao_vivo" | "suspeito";

/**
 * A porta de suspeita. Pura. `suspeito` quer dizer "pode ser histórico" — nunca
 * "é histórico": quem decide é a correlação por wamid.
 */
export function classificarEco(sentAt: Date, onboardingEm: string | null): ClasseDoEco {
  if (!onboardingEm) return "ao_vivo";
  const onboarding = Date.parse(onboardingEm);
  if (!Number.isFinite(onboarding)) return "ao_vivo";
  return sentAt.getTime() < onboarding - FOLGA_DO_ONBOARDING_MS ? "suspeito" : "ao_vivo";
}

/**
 * O onboarding atual do canal. `null` quer dizer só uma coisa: o canal NÃO TEM
 * onboarding (Cloud API dedicada, ou conectado antes da coexistência) — e aí o
 * eco segue ao vivo, como antes da 0496.
 *
 * Falha de leitura LANÇA, e nunca vira `null`: confundir "não consegui ler" com
 * "não existe" mandaria o eco suspeito pelo caminho ao vivo, que cria contato,
 * conversa e mensagem — o defeito que a quarentena existe para fechar. Lançando,
 * a rota responde 5xx e a Meta reentrega o eco.
 */
export async function lerOnboardingDoCanal(
  admin: Admin,
  organizationId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("meta_onboarding_em")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) {
    logger.error("[meta.eco] onboarding do canal não lido — eco recusado para a Meta reentregar", {
      organization_id: organizationId,
      channel_session_id: channelSessionId,
      detalhe: error.message.slice(0, 160),
    });
    throw new Error(`channel_sessions (onboarding): ${error.message}`);
  }
  return (data as { meta_onboarding_em?: string | null } | null)?.meta_onboarding_em ?? null;
}

/** O desfecho do eco: o da ingestão ao vivo, ou `em_espera` quando ficou na quarentena. */
export type DesfechoDoEco = IngestOutcome | { status: "em_espera" };

/**
 * Guarda o eco suspeito, bruto, na janela do canal. Idempotente por wamid: a
 * reentrega da Meta cai no `unique` e continua `em_espera`. Um wamid que já é
 * mensagem é `duplicate` e não entra na quarentena. LANÇA quando o banco falha,
 * para a rota responder 5xx e a Meta reentregar.
 */
export async function guardarEcoEmEspera(
  admin: Admin,
  input: AlvoDosEcos & { e: EchoMessageEvent; recebidoEm: Date },
): Promise<DesfechoDoEco> {
  const { e } = input;

  const { data: existente, error: erroDaBusca } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("external_id", e.externalId)
    .limit(1);
  if (erroDaBusca) throw new Error(`messages: ${erroDaBusca.message}`);
  if (((existente ?? []) as unknown[]).length > 0) return { status: "duplicate" };

  const { error } = await admin.from("meta_ecos_em_espera").insert({
    organization_id: input.organizationId,
    channel_session_id: input.channelSessionId,
    onboarding_em: input.onboardingEm,
    external_id: e.externalId,
    phone_number_id: e.phoneNumberId,
    waba_id: e.wabaId || null,
    sent_at: e.sentAt.toISOString(),
    recebido_em: input.recebidoEm.toISOString(),
    bruto: e.bruto ?? {},
  });
  if (error) {
    // Reentrega do mesmo eco: já está na quarentena, nada a fazer.
    if (error.code === "23505") return { status: "em_espera" };
    throw new Error(`meta_ecos_em_espera: ${error.message}`);
  }

  logger.info("[meta.eco] eco anterior ao onboarding guardado em espera", {
    organization_id: input.organizationId,
    channel_session_id: input.channelSessionId,
    external_id: e.externalId,
    sent_at: e.sentAt.toISOString(),
    onboarding_em: input.onboardingEm,
    tipo: e.type,
  });
  return { status: "em_espera" };
}

/**
 * Avisa que um pedaço de history da janela foi guardado, o que acorda o
 * resolvedor. Falha aqui não perde nada: o pedaço já está guardado e o cron
 * `meta-ecos-em-espera` passa por toda janela com espera.
 */
export async function emitirChunkGuardado(admin: Admin, alvo: AlvoDosEcos, origem: string): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: EVENTO_CHUNK_GUARDADO,
    p_entity_kind: "channel_session",
    p_entity_id: alvo.channelSessionId,
    p_payload: { channel_session_id: alvo.channelSessionId, onboarding_em: alvo.onboardingEm },
    p_metadata: { source: origem },
    p_organization_id: alvo.organizationId,
  } as never);
  if (error) {
    logger.warn("[meta.eco] aviso de pedaço de history guardado falhou — o cron cobre", {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      origem,
      detalhe: (error as { message?: string }).message?.slice(0, 160),
    });
  }
}

export type ContagemDosEcos = Record<EstadoDoEcoEmEspera, number>;

/** Quantos ecos da janela estão em cada estado — é o que a tela de sincronização mostra. */
export async function contarEcosEmEspera(admin: Admin, alvo: AlvoDosEcos): Promise<ContagemDosEcos> {
  const contagem: ContagemDosEcos = { aguardando: 0, historico: 0, promovido: 0, duplicado: 0 };
  const { data, error } = await admin
    .from("meta_ecos_em_espera")
    .select("estado")
    .eq("organization_id", alvo.organizationId)
    .eq("channel_session_id", alvo.channelSessionId)
    .eq("onboarding_em", alvo.onboardingEm)
    .limit(10_000);
  if (error) throw new Error(`meta_ecos_em_espera: ${error.message}`);
  for (const linha of (data ?? []) as Array<{ estado: string }>) {
    if ((ESTADOS_DO_ECO_EM_ESPERA as readonly string[]).includes(linha.estado)) {
      contagem[linha.estado as EstadoDoEcoEmEspera] += 1;
    }
  }
  return contagem;
}
