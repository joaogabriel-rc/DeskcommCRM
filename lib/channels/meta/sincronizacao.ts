/**
 * Sincronização do app WhatsApp Business num número em coexistência — a fase de
 * PRESERVAÇÃO (Fase 2.0, migration 0420).
 *
 * A Meta entrega o histórico de conversas e a agenda de contatos do aplicativo
 * só se o parceiro PEDIR (`POST /{phone}/smb_app_data`), em até 24h do
 * onboarding e UMA vez por tipo ("You can only perform this step once. If you
 * need to perform it again, the customer must first offboard, then complete the
 * Embedded Signup flow again."). Perder o prazo perde o dado. Esta fase só:
 *
 *   1. pede, na ordem documentada — contatos primeiro, histórico depois;
 *   2. guarda o `request_id` que a Meta devolve;
 *   3. guarda o `value` BRUTO de cada webhook `history`/`smb_app_state_sync`.
 *
 * ─── O que NÃO faz, de propósito ────────────────────────────────────────────
 * Não escreve em `messages`, `conversations` nem `contacts`. Uma linha em
 * `messages` dispara `message.received` (IA, push, fluxos, follow-up) pelo
 * trigger `trg_messages_emit_event`, e uma conversa nova pede distribuição de
 * atendimento (`trg_conversation_routing_requested`). Importar exige um caminho
 * sem esses efeitos, que é da fase seguinte.
 *
 * ─── Um pedido por tipo, e a reserva ────────────────────────────────────────
 * Antes de chamar a Meta, a linha do tipo passa a `solicitando` num UPDATE que só
 * casa `pendente`/`falhou` (ou uma reserva abandonada há mais de 5 minutos). Duas
 * chamadas simultâneas não pedem duas vezes: só uma reserva. `solicitada` nunca é
 * reservada de novo.
 *
 * ─── Um pedido por tipo POR ONBOARDING ──────────────────────────────────────
 * Toda linha carrega o `onboarding_em` a que pertence (= o `meta_onboarding_em`
 * do canal). Quem desliga o número no app e conecta de novo passa por um
 * onboarding novo, e a Meta abre outra janela: nascem linhas novas, com prazo
 * contado a partir DELE, e as do onboarding anterior ficam como estavam —
 * histórico, nunca apagado nem reaproveitado.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { contarEcosEmEspera, emitirChunkGuardado, type ContagemDosEcos } from "@/lib/channels/meta/ecos-em-espera";
import { sessionByPhoneNumberId } from "@/lib/channels/meta/ingest";
import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";

type Admin = SupabaseClient;

/** Vocabulário do CHECK `meta_sincronizacoes.tipo` (0420). */
export const TIPOS_DE_SINCRONIZACAO = ["contatos", "historico"] as const;
export type TipoDeSincronizacao = (typeof TIPOS_DE_SINCRONIZACAO)[number];

/** Vocabulário do CHECK `meta_sincronizacoes.status` (0420). */
export const ESTADOS_DA_SINCRONIZACAO = [
  "pendente",
  "solicitando",
  "solicitada",
  "falhou",
  "expirada",
  "recusada",
] as const;
export type EstadoDaSincronizacao = (typeof ESTADOS_DA_SINCRONIZACAO)[number];

/** Vocabulário do CHECK `meta_sincronizacao_payloads.campo` (0420) — o `field` do webhook. */
export const CAMPOS_DE_SINCRONIZACAO = ["history", "smb_app_state_sync"] as const;
export type CampoDeSincronizacao = (typeof CAMPOS_DE_SINCRONIZACAO)[number];

/** O prazo da Meta: o pedido tem de sair em até 24h do onboarding. */
export const PRAZO_DA_SINCRONIZACAO_MS = 24 * 60 * 60 * 1000;

/** Reserva `solicitando` mais velha que isto foi abandonada (processo caiu no meio). */
const RESERVA_ABANDONADA_MS = 5 * 60 * 1000;

/** O `sync_type` que a Meta espera para cada tipo. */
const SYNC_TYPE: Record<TipoDeSincronizacao, string> = {
  contatos: "smb_app_state_sync",
  historico: "history",
};

/** O tipo de pedido a que cada campo de webhook responde. */
const TIPO_DO_CAMPO: Record<CampoDeSincronizacao, TipoDeSincronizacao> = {
  smb_app_state_sync: "contatos",
  history: "historico",
};

/** "History sync is turned off by the business from the WhatsApp Business App". */
export const CODIGO_HISTORICO_RECUSADO = 2593109;

// ─── Chamada à Meta ─────────────────────────────────────────────────────────

export type PedidoNaMeta = { ok: true; requestId: string } | { ok: false; motivo: string };

/**
 * `POST /{phone}/smb_app_data`. O token vai no cabeçalho, nunca na URL, e o
 * motivo devolvido é o que a Meta disse — sem eco da requisição.
 */
export async function pedirSincronizacaoNaMeta(input: {
  phoneNumberId: string;
  token: string;
  tipo: TipoDeSincronizacao;
  graphVersion?: string;
}): Promise<PedidoNaMeta> {
  const versao = input.graphVersion ?? graphVersion();
  try {
    const res = await fetch(`https://graph.facebook.com/${versao}/${input.phoneNumberId}/smb_app_data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", sync_type: SYNC_TYPE[input.tipo] }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      request_id?: unknown;
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    if (!res.ok || body.error) {
      const detalhe = body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`;
      const codigo = body.error?.code !== undefined ? `meta_${body.error.code}: ` : "";
      return { ok: false, motivo: `${codigo}${detalhe}`.slice(0, 300) };
    }
    if (typeof body.request_id !== "string" || body.request_id.length === 0) {
      return { ok: false, motivo: "a Meta respondeu sem request_id" };
    }
    return { ok: true, requestId: body.request_id };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}`.slice(0, 300) };
  }
}

// ─── Estado ─────────────────────────────────────────────────────────────────

export interface LinhaDaSincronizacao {
  tipo: TipoDeSincronizacao;
  status: EstadoDaSincronizacao;
  request_id: string | null;
  solicitada_em: string | null;
  recebido_em: string | null;
  erro: string | null;
}

export type SituacaoDaSincronizacao =
  | { disponivel: false; motivo: "sem_canal_oficial" | "nao_e_coexistencia" | "sem_onboarding" }
  | {
      disponivel: true;
      channelSessionId: string;
      onboardingEm: string;
      prazo: string;
      dentroDoPrazo: boolean;
      contatos: LinhaDaSincronizacao | null;
      historico: LinhaDaSincronizacao | null;
      /**
       * Os ecos do app anteriores a ESTE onboarding (0436), por estado: em espera,
       * classificados como mídia do histórico, promovidos como eco tardio.
       * Opcional para quem monta a situação à mão (telas e testes antigos).
       */
      ecos?: ContagemDosEcos;
    };

interface SessaoDoCanal {
  id: string;
  meta_phone_number_id: string | null;
  meta_modo: string | null;
  meta_onboarding_em: string | null;
}

/** A sessão oficial ATIVA da organização — a organização vem de quem chama, nunca do corpo. */
async function sessaoOficial(admin: Admin, organizationId: string): Promise<SessaoDoCanal | null> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_modo, meta_onboarding_em")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) throw new Error(`sessao_oficial: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim());
  return (data as SessaoDoCanal | null) ?? null;
}

async function linhas(admin: Admin, organizationId: string, channelSessionId: string, onboardingEm: string) {
  const { data, error } = await admin
    .from("meta_sincronizacoes")
    .select("tipo, status, request_id, solicitada_em, recebido_em, erro")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("onboarding_em", onboardingEm);
  if (error) throw new Error(`meta_sincronizacoes: ${error.message}`);
  const lista = (data ?? []) as LinhaDaSincronizacao[];
  return {
    contatos: lista.find((l) => l.tipo === "contatos") ?? null,
    historico: lista.find((l) => l.tipo === "historico") ?? null,
  };
}

export async function lerSincronizacao(
  admin: Admin,
  organizationId: string,
  agora: Date = new Date(),
): Promise<SituacaoDaSincronizacao> {
  const sessao = await sessaoOficial(admin, organizationId);
  if (!sessao) return { disponivel: false, motivo: "sem_canal_oficial" };
  if (sessao.meta_modo !== "coexistencia") return { disponivel: false, motivo: "nao_e_coexistencia" };
  if (!sessao.meta_onboarding_em) return { disponivel: false, motivo: "sem_onboarding" };
  const prazo = new Date(Date.parse(sessao.meta_onboarding_em) + PRAZO_DA_SINCRONIZACAO_MS);
  return {
    disponivel: true,
    channelSessionId: sessao.id,
    onboardingEm: sessao.meta_onboarding_em,
    prazo: prazo.toISOString(),
    dentroDoPrazo: agora.getTime() <= prazo.getTime(),
    ...(await linhas(admin, organizationId, sessao.id, sessao.meta_onboarding_em)),
    ecos: await contarEcosEmEspera(admin, {
      organizationId,
      channelSessionId: sessao.id,
      onboardingEm: sessao.meta_onboarding_em,
    }),
  };
}

// ─── Pedido ─────────────────────────────────────────────────────────────────

export type DesfechoDoTipo =
  | "solicitada"
  | "ja_solicitada"
  | "em_andamento"
  | "falhou"
  | "expirada"
  | "aguardando_contatos"
  | "recusada";

export type DesfechoDoPedido =
  | { ok: false; motivo: "sem_canal_oficial" | "nao_e_coexistencia" | "sem_onboarding" | "sem_credencial" }
  | { ok: true; contatos: DesfechoDoTipo; historico: DesfechoDoTipo; situacao: SituacaoDaSincronizacao };

/** A linha-alvo de um pedido: organização, canal e o onboarding a que pertence. */
interface AlvoDaSincronizacao {
  organizationId: string;
  channelSessionId: string;
  onboardingEm: string;
}

/**
 * Tenta reservar o pedido do tipo. Devolve `true` só para QUEM reservou — é o
 * que impede dois pedidos do mesmo tipo à Meta.
 */
async function reservar(
  admin: Admin,
  alvo: AlvoDaSincronizacao,
  tipo: TipoDeSincronizacao,
  agora: Date,
): Promise<boolean> {
  const reservar = () =>
    admin
      .from("meta_sincronizacoes")
      .update({ status: "solicitando", tentativa_em: agora.toISOString(), erro: null })
      .eq("organization_id", alvo.organizationId)
      .eq("channel_session_id", alvo.channelSessionId)
      .eq("onboarding_em", alvo.onboardingEm)
      .eq("tipo", tipo);

  const primeira = await reservar().in("status", ["pendente", "falhou"]).select("tipo");
  if (primeira.error) throw new Error(`reserva: ${primeira.error.message}`);
  if ((primeira.data ?? []).length > 0) return true;

  const abandonada = new Date(agora.getTime() - RESERVA_ABANDONADA_MS).toISOString();
  const segunda = await reservar().eq("status", "solicitando").lt("tentativa_em", abandonada).select("tipo");
  if (segunda.error) throw new Error(`reserva: ${segunda.error.message}`);
  return (segunda.data ?? []).length > 0;
}

async function gravar(
  admin: Admin,
  alvo: AlvoDaSincronizacao,
  tipo: TipoDeSincronizacao,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("meta_sincronizacoes")
    .update(patch)
    .eq("organization_id", alvo.organizationId)
    .eq("channel_session_id", alvo.channelSessionId)
    .eq("onboarding_em", alvo.onboardingEm)
    .eq("tipo", tipo);
  if (error) throw new Error(`meta_sincronizacoes: ${error.message}`);
}

async function pedirUm(
  admin: Admin,
  ctx: AlvoDaSincronizacao & { phoneNumberId: string; token: string; agora: Date; requestId?: string },
  tipo: TipoDeSincronizacao,
  atual: LinhaDaSincronizacao | null,
): Promise<DesfechoDoTipo> {
  if (atual?.status === "solicitada") return "ja_solicitada";
  if (atual?.status === "recusada") return "recusada";
  if (!(await reservar(admin, ctx, tipo, ctx.agora))) return "em_andamento";

  const pedido = await pedirSincronizacaoNaMeta({ phoneNumberId: ctx.phoneNumberId, token: ctx.token, tipo });
  if (pedido.ok) {
    await gravar(admin, ctx, tipo, {
      status: "solicitada",
      request_id: pedido.requestId,
      solicitada_em: new Date().toISOString(),
      erro: null,
    });
    return "solicitada";
  }
  await gravar(admin, ctx, tipo, { status: "falhou", erro: pedido.motivo });
  logger.warn("[meta.sincronizacao] a Meta recusou o pedido", {
    requestId: ctx.requestId,
    organization_id: ctx.organizationId,
    tipo,
    motivo: pedido.motivo,
  });
  return "falhou";
}

/**
 * Pede a sincronização do app — contatos primeiro, histórico só depois que o
 * pedido de contatos foi ACEITO pela Meta. Fora do prazo de 24h não chama a
 * Meta: o que não foi pedido vira `expirada`.
 */
export async function solicitarSincronizacaoDoApp(
  admin: Admin,
  input: { organizationId: string; agora?: Date; requestId?: string },
): Promise<DesfechoDoPedido> {
  const agora = input.agora ?? new Date();
  const sessao = await sessaoOficial(admin, input.organizationId);
  if (!sessao || !sessao.meta_phone_number_id) return { ok: false, motivo: "sem_canal_oficial" };
  if (sessao.meta_modo !== "coexistencia") return { ok: false, motivo: "nao_e_coexistencia" };
  if (!sessao.meta_onboarding_em) return { ok: false, motivo: "sem_onboarding" };

  // As duas linhas existem antes de qualquer reserva. `ignoreDuplicates`: a linha
  // que já existe fica como está — nunca volta a `pendente`.
  const { error: erroDasLinhas } = await admin.from("meta_sincronizacoes").upsert(
    TIPOS_DE_SINCRONIZACAO.map((tipo) => ({
      organization_id: input.organizationId,
      channel_session_id: sessao.id,
      onboarding_em: sessao.meta_onboarding_em,
      tipo,
    })),
    { onConflict: "channel_session_id,onboarding_em,tipo", ignoreDuplicates: true },
  );
  if (erroDasLinhas) throw new Error(`meta_sincronizacoes: ${erroDasLinhas.message}`);

  const prazo = Date.parse(sessao.meta_onboarding_em) + PRAZO_DA_SINCRONIZACAO_MS;
  if (agora.getTime() > prazo) {
    const { error } = await admin
      .from("meta_sincronizacoes")
      .update({ status: "expirada" })
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", sessao.id)
      .eq("onboarding_em", sessao.meta_onboarding_em)
      .in("status", ["pendente", "falhou", "solicitando"]);
    if (error) throw new Error(`meta_sincronizacoes: ${error.message}`);
    const situacao = await lerSincronizacao(admin, input.organizationId, agora);
    const desfechoDe = (l: LinhaDaSincronizacao | null): DesfechoDoTipo =>
      l?.status === "solicitada" ? "ja_solicitada" : l?.status === "recusada" ? "recusada" : "expirada";
    return situacao.disponivel
      ? { ok: true, contatos: desfechoDe(situacao.contatos), historico: desfechoDe(situacao.historico), situacao }
      : { ok: true, contatos: "expirada", historico: "expirada", situacao };
  }

  const creds = await resolveMetaCreds(admin, {
    organizationId: input.organizationId,
    phoneNumberId: sessao.meta_phone_number_id,
  });
  if (!creds) return { ok: false, motivo: "sem_credencial" };

  const ctx = {
    organizationId: input.organizationId,
    channelSessionId: sessao.id,
    onboardingEm: sessao.meta_onboarding_em,
    phoneNumberId: sessao.meta_phone_number_id,
    token: creds.token,
    agora,
    requestId: input.requestId,
  };
  const antes = await linhas(admin, input.organizationId, sessao.id, sessao.meta_onboarding_em);

  const contatos = await pedirUm(admin, ctx, "contatos", antes.contatos);
  const contatosAceitos = contatos === "solicitada" || contatos === "ja_solicitada";
  const historico = contatosAceitos
    ? await pedirUm(admin, ctx, "historico", antes.historico)
    : antes.historico?.status === "solicitada"
      ? "ja_solicitada"
      : "aguardando_contatos";

  return { ok: true, contatos, historico, situacao: await lerSincronizacao(admin, input.organizationId, agora) };
}

// ─── Webhook: guardar o payload bruto ───────────────────────────────────────

export type DesfechoDaGuarda = "guardado" | "duplicate" | "no_session";

/**
 * Guarda o `value` BRUTO de um webhook `history`/`smb_app_state_sync` para o
 * canal dono do número, dentro da organização de quem chama.
 *
 * Idempotente pelo hash do `value`: a Meta reentrega o mesmo corpo, e o
 * `unique (channel_session_id, campo, payload_hash)` devolve 23505. LANÇA quando
 * o banco falha, para a rota responder 5xx e a Meta reentregar — perder um
 * pedaço do histórico com um 200 é o que esta fase existe para evitar.
 */
export async function guardarPayloadDeSincronizacao(
  admin: Admin,
  e: { campo: CampoDeSincronizacao; phoneNumberId: string; value: Record<string, unknown> },
  dono: { organizationId: string },
): Promise<DesfechoDaGuarda> {
  const sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  if (!sessao) {
    logger.warn("[meta.sincronizacao] payload descartado: número sem sessão na organização", {
      motivo: "no_session",
      campo: e.campo,
      phone_number_id: e.phoneNumberId,
      organization_id: dono.organizationId,
    });
    return "no_session";
  }

  const bruto = JSON.stringify(e.value);
  const hash = createHash("sha256").update(bruto, "utf8").digest("hex");
  const meta = e.campo === "history" ? metadadosDoHistorico(e.value) : null;

  // O onboarding ATUAL do canal: o que chega agora responde ao pedido desta
  // janela, nunca ao de uma conexão anterior. Lido ANTES de guardar, porque o
  // payload leva a janela junto (0436) — é por ela que a correlação dos ecos não
  // mistura reconexões.
  //
  // Sem conseguir ler, LANÇA antes de gravar: um pedaço guardado sem janela nunca
  // seria lido pela correlação (que filtra pela janela), e a reentrega cairia no
  // `unique` e o deixaria sem janela para sempre. Não gravando, a rota responde
  // 5xx e a Meta reentrega o MESMO pedaço — nada se perde.
  const { data: canal, error: erroDoCanal } = await admin
    .from("channel_sessions")
    .select("meta_onboarding_em")
    .eq("organization_id", sessao.organization_id)
    .eq("id", sessao.id)
    .maybeSingle();
  if (erroDoCanal) {
    logger.error("[meta.sincronizacao] janela do payload não lida — payload recusado para a Meta reentregar", {
      campo: e.campo,
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      detalhe: erroDoCanal.message.slice(0, 160),
    });
    throw new Error(`channel_sessions (janela do payload): ${erroDoCanal.message}`);
  }
  const onboardingEm = (canal as { meta_onboarding_em?: string | null } | null)?.meta_onboarding_em ?? null;

  const { error } = await admin.from("meta_sincronizacao_payloads").insert({
    organization_id: sessao.organization_id,
    channel_session_id: sessao.id,
    campo: e.campo,
    payload: e.value,
    payload_hash: hash,
    fase: meta?.fase ?? null,
    chunk_order: meta?.chunkOrder ?? null,
    progresso: meta?.progresso ?? null,
    onboarding_em: onboardingEm,
  });
  if (error) {
    if (error.code === "23505") {
      logger.info("[meta.sincronizacao] payload repetido (reentrega) — já estava guardado", {
        motivo: "duplicate",
        campo: e.campo,
        organization_id: sessao.organization_id,
        channel_session_id: sessao.id,
        payload_hash_12: hash.slice(0, 12),
      });
      return "duplicate";
    }
    throw new Error(`meta_sincronizacao_payloads: ${error.message}`);
  }

  // A evidência positiva: o payload chegou e está persistido.
  logger.info("[meta.sincronizacao] payload guardado", {
    campo: e.campo,
    organization_id: sessao.organization_id,
    channel_session_id: sessao.id,
    payload_hash_12: hash.slice(0, 12),
    fase: meta?.fase ?? null,
    chunk_order: meta?.chunkOrder ?? null,
    progresso: meta?.progresso ?? null,
  });

  // Canal SEM onboarding (leitura bem-sucedida, coluna vazia): não há janela a
  // que o pedaço pertença, e nenhum eco é suspeito nesse canal — guardado, e fica
  // visível no log.
  if (!onboardingEm) {
    logger.warn("[meta.sincronizacao] payload guardado sem janela: o canal não tem onboarding", {
      campo: e.campo,
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
    });
    return "guardado";
  }

  // O primeiro payload marca que a Meta começou a entregar. Falha aqui não
  // desfaz a guarda: o dado já está salvo, e é ele que importa.
  const tipo = TIPO_DO_CAMPO[e.campo];
  const { error: erroDoEstado } = await admin
    .from("meta_sincronizacoes")
    .update({ recebido_em: new Date().toISOString() })
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .eq("onboarding_em", onboardingEm)
    .eq("tipo", tipo)
    .is("recebido_em", null);
  if (erroDoEstado) avisarEstado(sessao.organization_id, e.campo, erroDoEstado.message);

  // A recusa do histórico é um ESTADO, não um dado: nada é importado.
  if (e.campo === "history" && historicoRecusado(e.value)) {
    const { error: erroDaRecusa } = await admin
      .from("meta_sincronizacoes")
      .update({
        status: "recusada",
        erro: `meta_${CODIGO_HISTORICO_RECUSADO}: compartilhamento do histórico desligado no aplicativo`,
      })
      .eq("organization_id", sessao.organization_id)
      .eq("channel_session_id", sessao.id)
      .eq("onboarding_em", onboardingEm)
      .eq("tipo", "historico");
    if (erroDaRecusa) avisarEstado(sessao.organization_id, e.campo, erroDaRecusa.message);
  }

  // Um pedaço novo de history pode ser o que faltava para decidir um eco em
  // espera desta janela (0436). Só ACORDA o resolvedor: nada é processado aqui.
  if (e.campo === "history") {
    await emitirChunkGuardado(
      admin,
      { organizationId: sessao.organization_id, channelSessionId: sessao.id, onboardingEm },
      "historico_guardado",
    );
  }
  return "guardado";
}

function avisarEstado(organizationId: string, campo: string, detalhe: string): void {
  logger.warn("[meta.sincronizacao] estado não atualizado — o payload já está guardado", {
    organization_id: organizationId,
    campo,
    detalhe: detalhe.slice(0, 160),
  });
}

function metadadosDoHistorico(value: Record<string, unknown>): { fase: number | null; chunkOrder: number | null; progresso: number | null } | null {
  const lista = Array.isArray(value.history) ? (value.history as Array<Record<string, unknown>>) : [];
  const m = (lista[0]?.metadata ?? null) as Record<string, unknown> | null;
  if (!m) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
  return { fase: num(m.phase), chunkOrder: num(m.chunk_order), progresso: num(m.progress) };
}

function historicoRecusado(value: Record<string, unknown>): boolean {
  const lista = Array.isArray(value.history) ? (value.history as Array<Record<string, unknown>>) : [];
  return lista.some(
    (h) => Array.isArray(h.errors) && (h.errors as Array<{ code?: unknown }>).some((x) => x.code === CODIGO_HISTORICO_RECUSADO),
  );
}
