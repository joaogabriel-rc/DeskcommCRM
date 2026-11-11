/**
 * MENSAGEM APAGADA PELO CONTATO: O CONTEÚDO SAI DE TODO LUGAR.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 * Apagar ("apagar para todos") só gravava `revoked_at`. O texto continuava na
 * linha, e só a bolha da Inbox o escondia. Todo o resto o entregava: a API de
 * mensagens, o PostgREST direto (`messages_select`), o Realtime (`messages` está
 * na publicação), a prévia da conversa, o `body_preview` do `event_log`, o arquivo
 * cru do webhook, a base de conhecimento da IA (`ai_chunks`) e o contexto do
 * agente. Auditado em 10/11/2026.
 *
 * ─── A regra (decisão do dono do produto, 10/11/2026) ───────────────────────
 *   - RECEBIDA apagada pelo contato: o conteúdo é APAGADO, sem cópia restrita.
 *     Somem `body`, a mídia (colunas, arquivo no Storage e o id da mídia na
 *     plataforma), a transcrição, o conteúdo do `metadata`, a prévia, o
 *     `body_preview` dos eventos, o corpo cru dos arquivos de webhook e os
 *     trechos indexados no RAG. Fica a RASTREABILIDADE: a linha, `revoked_at`,
 *     ids, tipo, quem e quando — e `metadata.apagamento`.
 *   - ENVIADA apagada pela empresa: só `revoked_at`. O conteúdo é da própria
 *     empresa e continua "Visível só aqui no CRM" para a equipe.
 *
 * ─── Como, e por que nesta ordem ────────────────────────────────────────────
 * Os efeitos FORA da linha (prévia, eventos, arquivos, RAG, fila do Storage)
 * rodam ANTES do update da linha, e todos são idempotentes. Se um falhar, a
 * função devolve o erro, a rota pede reentrega (503) e a próxima tentativa refaz
 * tudo. O contrário — marcar a linha primeiro — faria a reentrega achar a
 * mensagem já apagada e nunca limpar o que ficou para trás.
 *
 * O arquivo de mídia não é removido aqui: entra na `storage_redaction_queue`, a
 * mesma fila durável (com nova tentativa) que a cascata LGPD usa, drenada pelo
 * cron `storage-redaction`.
 *
 * Toda escrita é escopada por `organization_id` — o `wamid` sozinho se repete
 * entre organizações.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ErroDoBancoLike } from "@/lib/channels/falha-do-banco";
import { logger } from "@/lib/logger";

type Admin = SupabaseClient;

/** O que a lista de conversas mostra no lugar da prévia apagada — o mesmo texto da bolha. */
export const PREVIA_DE_MENSAGEM_APAGADA = "Esta mensagem foi apagada";

/** Bucket privado da mídia das conversas (`workers/media-persist-worker.ts`). */
export const BUCKET_DA_MIDIA = "whatsapp-media";

/** As colunas de `messages` que guardam CONTEÚDO. Todas viram nulas na recebida apagada. */
export const COLUNAS_DE_CONTEUDO = {
  body: null,
  media_url: null,
  media_mime: null,
  media_size_bytes: null,
  media_storage_path: null,
  media_derived_text: null,
  media_derived_status: null,
} as const;

/**
 * As chaves de `metadata` que NÃO são conteúdo — marcas técnicas e de origem.
 * Lista de PERMITIDOS: chave que um canal acrescentar amanhã (um anexo, um
 * cartão, o id de uma mídia) sai por não estar aqui.
 */
const METADATA_PERMITIDO = [
  "raw_type",
  "ack_name",
  "source",
  "origem",
  "group_sender",
  "crm_hidden_at",
  "crm_hidden_by",
  "meta_tipo",
  "conteudo_indisponivel",
  "meta_original_sanitizado",
] as const;

/** Do item cru da plataforma (`meta_original`), só identificadores e tipo. */
const ORIGINAL_PERMITIDO = ["id", "from", "from_user_id", "to", "timestamp", "type"] as const;
const CONTEXTO_PERMITIDO = ["id", "from"] as const;

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function soPermitidos(o: Record<string, unknown>, permitidos: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of permitidos) if (k in o) out[k] = o[k];
  return out;
}

/**
 * O `metadata` de uma recebida apagada: só o técnico, mais a marca do
 * apagamento. Pura e idempotente.
 */
export function metadataDaRecebidaApagada(
  metadata: Record<string, unknown> | null | undefined,
  apagamento: { em: string; canal: string },
): Record<string, unknown> {
  const m = objeto(metadata) ?? {};
  const out = soPermitidos(m, METADATA_PERMITIDO);
  const original = objeto(m.meta_original);
  if (original) {
    const limpo = soPermitidos(original, ORIGINAL_PERMITIDO);
    const contexto = objeto(original.context);
    if (contexto) limpo.context = soPermitidos(contexto, CONTEXTO_PERMITIDO);
    out.meta_original = limpo;
    out.meta_original_sanitizado = "revoke";
  }
  // A primeira marca vale: reaplicar não muda o "quando".
  const anterior = objeto(m.apagamento);
  out.apagamento = anterior ?? { em: apagamento.em, por: "contato", canal: apagamento.canal, conteudo: "removido" };
  return out;
}

/**
 * Defesa na LEITURA: a recebida apagada sai sem conteúdo mesmo que a linha ainda
 * o tenha (linha apagada antes desta regra, ou lida no meio do apagamento).
 * A enviada apagada passa intacta — é "Visível só aqui no CRM". Pura.
 */
export function semConteudoApagado<
  T extends { direction?: string | null; revoked_at?: string | null; metadata?: unknown },
>(linha: T): T {
  if (linha.direction !== "inbound" || !linha.revoked_at) return linha;
  const out: Record<string, unknown> = { ...linha };
  for (const k of Object.keys(COLUNAS_DE_CONTEUDO)) if (k in out) out[k] = null;
  if ("metadata" in out) {
    out.metadata = metadataDaRecebidaApagada(objeto(linha.metadata), { em: linha.revoked_at, canal: "desconhecido" });
  }
  return out as T;
}

export type ResultadoDoApagamento =
  | { status: "apagada" | "ja_apagada" | "nao_encontrada" }
  | { status: "falhou"; tabela: string; erro: ErroDoBancoLike };

interface LinhaDaMensagem {
  id: string;
  conversation_id: string;
  external_id: string | null;
  direction: string;
  revoked_at: string | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

const COLUNAS_LIDAS =
  "id, conversation_id, external_id, direction, revoked_at, media_storage_path, metadata, updated_at";
const TENTATIVAS_POR_CONFLITO = 3;

const falhou = (tabela: string, erro: ErroDoBancoLike): ResultadoDoApagamento => ({ status: "falhou", tabela, erro });

/**
 * Apaga a mensagem `messageId` da organização. Recebida: conteúdo removido de
 * todo lugar. Enviada: só `revoked_at` (o conteúdo segue visível para a equipe).
 *
 * `quando` é o instante do apagamento na plataforma (o `timestamp` do evento),
 * para que reentregas gravem o mesmo valor.
 */
export async function apagarMensagem(
  admin: Admin,
  alvo: { organizationId: string; messageId: string; quando: string; canal: string },
): Promise<ResultadoDoApagamento> {
  for (let tentativa = 0; tentativa < TENTATIVAS_POR_CONFLITO; tentativa += 1) {
    const { data, error } = await admin
      .from("messages")
      .select(COLUNAS_LIDAS)
      .eq("organization_id", alvo.organizationId)
      .eq("id", alvo.messageId)
      .maybeSingle();
    if (error) return falhou("messages", error);
    const linha = data as LinhaDaMensagem | null;
    if (!linha) return { status: "nao_encontrada" };

    // ── ENVIADA: só a marca. O histórico interno da equipe fica. ──
    if (linha.direction !== "inbound") {
      if (linha.revoked_at) return { status: "ja_apagada" };
      const { data: feita, error: erroDaMarca } = await admin
        .from("messages")
        .update({ revoked_at: alvo.quando })
        .eq("organization_id", alvo.organizationId)
        .eq("id", linha.id)
        .is("revoked_at", null)
        .select("id");
      if (erroDaMarca) return falhou("messages", erroDaMarca);
      return { status: Array.isArray(feita) && feita.length > 0 ? "apagada" : "ja_apagada" };
    }

    // ── RECEBIDA: primeiro tudo o que mora FORA da linha (idempotente). ──
    const fora = await limparForaDaLinha(admin, alvo.organizationId, linha);
    if (fora) return fora;

    const jaApagada = Boolean(linha.revoked_at);
    const { data: feita, error: erroDaLinha } = await admin
      .from("messages")
      .update({
        ...COLUNAS_DE_CONTEUDO,
        revoked_at: linha.revoked_at ?? alvo.quando,
        metadata: metadataDaRecebidaApagada(linha.metadata, { em: alvo.quando, canal: alvo.canal }),
      })
      .eq("organization_id", alvo.organizationId)
      .eq("id", linha.id)
      .eq("updated_at", linha.updated_at)
      .select("id");
    if (erroDaLinha) return falhou("messages", erroDaLinha);
    if (Array.isArray(feita) && feita.length > 0) {
      if (!jaApagada) {
        logger.info("[apagamento] conteúdo de mensagem recebida apagada removido", {
          organization_id: alvo.organizationId,
          message_id: linha.id,
          conversation_id: linha.conversation_id,
          canal: alvo.canal,
        });
      }
      return { status: jaApagada ? "ja_apagada" : "apagada" };
    }
    // Zero linhas: outra escrita mexeu na linha depois da leitura. Relê.
  }
  return falhou("messages", {
    code: "40001",
    message: "apagamento: conflito de escrita persistente na mensagem",
  });
}

/**
 * Tudo o que guarda o conteúdo FORA da linha. Cada passo é idempotente e
 * escopado à organização. Devolve a falha do primeiro passo que falhar.
 */
async function limparForaDaLinha(
  admin: Admin,
  organizationId: string,
  linha: LinhaDaMensagem,
): Promise<ResultadoDoApagamento | null> {
  // 1 · A prévia da conversa, se esta é a última mensagem dela.
  const { data: ultima, error: erroDaUltima } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", linha.conversation_id)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroDaUltima) return falhou("messages", erroDaUltima);
  if ((ultima as { id?: string } | null)?.id === linha.id) {
    const { error } = await admin
      .from("conversations")
      .update({ last_message_preview: PREVIA_DE_MENSAGEM_APAGADA })
      .eq("organization_id", organizationId)
      .eq("id", linha.conversation_id);
    if (error) return falhou("conversations", error);
  }

  // 2 · `body_preview` dos eventos desta mensagem (o trigger o grava na chegada).
  const { data: eventos, error: erroDosEventos } = await admin
    .from("event_log")
    .select("id, payload")
    .eq("organization_id", organizationId)
    .eq("payload->>message_id", linha.id);
  if (erroDosEventos) return falhou("event_log", erroDosEventos);
  for (const ev of (eventos ?? []) as Array<{ id: string; payload: Record<string, unknown> | null }>) {
    const payload = objeto(ev.payload);
    if (!payload || (!("body_preview" in payload) && !("body" in payload))) continue;
    const { body_preview: _preview, body: _body, ...semConteudo } = payload;
    const { error } = await admin
      .from("event_log")
      .update({ payload: semConteudo })
      .eq("organization_id", organizationId)
      .eq("id", ev.id);
    if (error) return falhou("event_log", error);
  }

  // 3 · Corpo cru dos arquivos de webhook desta mensagem: o `external_id` (Meta:
  //     recusados e pendências) e o id dentro do payload do canal por QR.
  if (linha.external_id) {
    for (const filtro of ["external_id", "payload_parsed->payload->>id"] as const) {
      const { error } = await admin
        .from("webhook_events_log")
        .update({ raw_body: null, payload_parsed: null, headers: null, archived_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq(filtro, linha.external_id)
        .not("raw_body", "is", null);
      if (error) return falhou("webhook_events_log", error);
    }
  }

  // 4 · Trechos indexados no RAG a partir desta conversa. A conversa volta à fila
  //     de indexação (se estava nela), e a reindexação pula mensagem apagada.
  const { error: erroDoRag } = await admin
    .from("ai_chunks")
    .delete()
    .eq("organization_id", organizationId)
    .eq("metadata->>conversation_id", linha.conversation_id);
  if (erroDoRag) return falhou("ai_chunks", erroDoRag);
  const { error: erroDaFilaDoRag } = await admin
    .from("conversations")
    .update({ usable_for_rag_marked_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", linha.conversation_id)
    .not("usable_for_rag_marked_at", "is", null);
  if (erroDaFilaDoRag) return falhou("conversations", erroDaFilaDoRag);

  // 5 · O arquivo da mídia: fila durável da LGPD (com nova tentativa).
  if (linha.media_storage_path) {
    const { data: naFila, error: erroDaBuscaNaFila } = await admin
      .from("storage_redaction_queue")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("bucket", BUCKET_DA_MIDIA)
      .eq("object_path", linha.media_storage_path)
      .limit(1);
    if (erroDaBuscaNaFila) return falhou("storage_redaction_queue", erroDaBuscaNaFila);
    if (!Array.isArray(naFila) || naFila.length === 0) {
      const { error } = await admin.from("storage_redaction_queue").insert({
        organization_id: organizationId,
        bucket: BUCKET_DA_MIDIA,
        object_path: linha.media_storage_path,
      });
      // 23505 = o arquivo já está na fila (único por bucket + caminho): uma
      // tentativa concorrente chegou antes. O efeito é o mesmo.
      if (error && error.code !== "23505") return falhou("storage_redaction_queue", error);
    }
  }
  return null;
}
