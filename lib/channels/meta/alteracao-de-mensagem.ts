/**
 * MENSAGEM APAGADA OU EDITADA NO WHATSAPP OFICIAL — pelo contato ou pela empresa.
 *
 * `revoke` e `edit` não são mensagem nova: alteram uma que já existe. Antes
 * viravam um `insert` com `type` que `messages_type_check` recusa (23514), e o
 * CRM seguia mostrando o texto que o cliente apagou ou corrigiu. O modelo é o
 * mesmo do canal por QR (`lib/waha/ingest.ts`, `handleMessageEdited` /
 * `handleMessageRevoked`) e a bolha da Inbox já sabe ler as duas colunas:
 *
 *   - `revoke` → `revoked_at` na ORIGINAL. A linha fica (o contexto das
 *     vizinhas e o histórico de quem atendeu dependem dela); a tela esconde o texto;
 *   - `edit`   → o `body` novo e `edited_at`. Sobrescreve, sem histórico de
 *     versões — a mesma regra do canal por QR.
 *
 * A original é procurada por `original_message_id` DENTRO da organização da
 * sessão dona do evento — nunca pelo `wamid` sozinho, que se repete entre
 * organizações.
 *
 * ─── Quando a alteração chega ANTES da original ─────────────────────────────
 * A Meta não garante ordem, e com o 503 ela reentrega. A alteração é guardada
 * em `webhook_events_log` (`status = 'received'`, `external_id` = o
 * `original_message_id`) e aplicada quando a original for gravada
 * (`aplicarAlteracoesPendentes`, chamada pela ingestão). Nenhuma linha
 * artificial é criada: o CRM não inventa uma mensagem apagada que nunca viu, e
 * uma edição pendente nunca vira apagamento.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *   - `revoke` só grava se `revoked_at` ainda é nulo;
 *   - `edit` só grava se não há edição mais nova (`edited_at` menor que a deste
 *     evento) e se a mensagem não foi apagada;
 *   - a pendência é deduplicada pelo `wamid` do próprio evento.
 * Reentregar qualquer um deles não muda nada.
 *
 * As funções devolvem o erro do banco em vez de classificá-lo: quem decide 503,
 * 500 ou 200 é `processar-evento.ts`, num lugar só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import type { ErroDoBancoLike } from "@/lib/channels/falha-do-banco";
import { logger } from "@/lib/logger";

import { alteracaoDaMensagem, type MessageChangeEvent } from "./webhook";

type Admin = SupabaseClient;

/** `event_type` da pendência em `webhook_events_log`. */
export const PENDENCIA_DE_ALTERACAO = {
  revoke: "meta.message_revoke",
  edit: "meta.message_edit",
} as const;

export type ResultadoDaAlteracao =
  | { status: "aplicada" | "ja_aplicada" | "pendente" | "pendente_repetida" }
  | { status: "falhou"; tabela: string; erro: ErroDoBancoLike };

/**
 * ─── O conteúdo que a alteração tirou de circulação não sobra em `metadata` ───
 *
 * A ingestão guarda o item cru da Meta em `metadata.meta_original`. Sem esta
 * limpeza, depois de um `edit` o original seguia com o texto ANTERIOR, e depois de
 * um `revoke` com uma segunda cópia do texto APAGADO — e a API de mensagens
 * (`/api/v1/conversations/[id]/messages`) devolve `metadata` inteiro ao navegador.
 * A bolha escondia; o JSON entregava. Medido na prova visual de 08/11/2026.
 *
 * É lista de PERMITIDOS, não de proibidos: o que a Meta acrescentar amanhã ao
 * item (um campo de conteúdo novo) não escapa por não estar numa lista negra.
 * Do original ficam só os identificadores e o tipo — o que auditoria e
 * processamento usam (de quem, quando, que tipo, a qual mensagem respondia).
 *
 *   - `edit`:   o original perde o conteúdo; o texto NOVO fica em `body`.
 *   - `revoke`: além disso, saem as cópias DERIVADAS do conteúdo que a conversão
 *               de tipo pôs em `metadata` (pedido, interativa, formulário,
 *               localização, reação, cartão). Nenhuma cópia alternativa fica.
 *
 * Mesma regra do canal por QR (`lib/waha/ingest.ts`, `handleMessageEdited`):
 * guardar a versão anterior é outra funcionalidade, com tela e retenção próprias.
 * O `body` de uma mensagem APAGADA continua como estava antes desta mudança — a
 * tela o esconde; tirá-lo da API é decisão separada, que vale para todos os canais.
 */
const CAMPOS_ESTRUTURAIS_DO_ORIGINAL = [
  "id",
  "from",
  "from_user_id",
  "to",
  "timestamp",
  "type",
] as const;
/** Da referência de resposta (`context`), só os identificadores. */
const CAMPOS_ESTRUTURAIS_DO_CONTEXTO = ["id", "from"] as const;
/** Cópias do conteúdo que a conversão de tipo grava ao lado do original. */
const DERIVADOS_DO_CONTEUDO = [
  "order",
  "interactive",
  "flow",
  "location",
  "reaction",
  "unsupported",
  "shared_contact",
] as const;

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pura e idempotente: aplicar duas vezes dá o mesmo `metadata`. */
export function sanitizarMetadataDaAlteracao(
  metadata: Record<string, unknown> | null | undefined,
  acao: "revoke" | "edit",
): Record<string, unknown> {
  const m: Record<string, unknown> = { ...(metadata ?? {}) };
  const original = objeto(m.meta_original);
  if (original) {
    const limpo: Record<string, unknown> = {};
    for (const campo of CAMPOS_ESTRUTURAIS_DO_ORIGINAL) {
      if (campo in original) limpo[campo] = original[campo];
    }
    const contexto = objeto(original.context);
    if (contexto) {
      const ctx: Record<string, unknown> = {};
      for (const campo of CAMPOS_ESTRUTURAIS_DO_CONTEXTO) {
        if (campo in contexto) ctx[campo] = contexto[campo];
      }
      limpo.context = ctx;
    }
    m.meta_original = limpo;
  }
  if (acao === "revoke") {
    for (const campo of DERIVADOS_DO_CONTEUDO) delete m[campo];
  }
  // `revoke` vence `edit`: mensagem apagada depois de editada fica marcada como apagada.
  m.meta_original_sanitizado =
    acao === "revoke" || m.meta_original_sanitizado === "revoke" ? "revoke" : "edit";
  return m;
}

interface Original {
  id: string;
  revoked_at: string | null;
  edited_at: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

const COLUNAS_DA_ORIGINAL = "id, revoked_at, edited_at, metadata, updated_at";
/** Outra escrita na mesma linha entre a leitura e o UPDATE: relê e tenta de novo. */
const TENTATIVAS_POR_CONFLITO = 3;

/**
 * Aplica a alteração NA ORIGINAL, com o `metadata` sanitizado no MESMO update —
 * não há instante em que a alteração vale e o conteúdo antigo ainda está no
 * original. Concorrência otimista por `updated_at`: o `metadata` é recalculado a
 * partir da linha lida, e um update concorrente (a tela ocultando a mensagem,
 * p.ex.) não é atropelado — a linha é relida e a decisão refeita.
 */
async function aplicarNaOriginal(
  admin: Admin,
  organizationId: string,
  originalId: string,
  e: Pick<MessageChangeEvent, "acao" | "sentAt" | "novoTexto">,
): Promise<ResultadoDaAlteracao> {
  const quando = e.sentAt.toISOString();
  for (let tentativa = 0; tentativa < TENTATIVAS_POR_CONFLITO; tentativa += 1) {
    const { data: lida, error: erroDaLeitura } = await admin
      .from("messages")
      .select(COLUNAS_DA_ORIGINAL)
      .eq("organization_id", organizationId)
      .eq("id", originalId)
      .maybeSingle();
    if (erroDaLeitura) return { status: "falhou", tabela: "messages", erro: erroDaLeitura };
    const original = lida as Original | null;
    if (!original) return { status: "ja_aplicada" };

    // Apagada não volta; edição de mensagem apagada não ressuscita o texto; edição
    // mais velha que a já gravada (reentrega fora de ordem) não desfaz a mais nova.
    if (original.revoked_at) return { status: "ja_aplicada" };
    if (
      e.acao === "edit" &&
      original.edited_at &&
      Date.parse(original.edited_at) >= e.sentAt.getTime()
    ) {
      return { status: "ja_aplicada" };
    }

    const metadata = sanitizarMetadataDaAlteracao(original.metadata, e.acao);
    const patch =
      e.acao === "revoke"
        ? { revoked_at: quando, metadata }
        : { ...(e.novoTexto !== null ? { body: e.novoTexto } : {}), edited_at: quando, metadata };
    let consulta = admin
      .from("messages")
      .update(patch)
      .eq("organization_id", organizationId)
      .eq("id", original.id)
      .eq("updated_at", original.updated_at)
      .is("revoked_at", null);
    if (e.acao === "edit") consulta = consulta.or(`edited_at.is.null,edited_at.lt.${quando}`);
    const { data, error } = await consulta.select("id");
    if (error) return { status: "falhou", tabela: "messages", erro: error };
    if (Array.isArray(data) && data.length > 0) return { status: "aplicada" };
    // Zero linhas: alguém escreveu na linha depois da leitura. Relê e decide de novo.
  }
  return {
    status: "falhou",
    tabela: "messages",
    erro: {
      code: "40001",
      message: "alteracao_de_mensagem: conflito de escrita persistente na mensagem original",
    },
  };
}

/**
 * Aplica um `revoke`/`edit` recém-chegado. Original encontrada → aplica;
 * ausente → guarda como pendência para quando ela chegar.
 */
export async function aplicarAlteracaoDaMensagem(
  admin: Admin,
  e: MessageChangeEvent,
  sessao: { id: string; organizationId: string },
): Promise<ResultadoDaAlteracao> {
  const { data: original, error: erroDaBusca } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", sessao.organizationId)
    .eq("external_id", e.originalId)
    .maybeSingle();
  if (erroDaBusca) return { status: "falhou", tabela: "messages", erro: erroDaBusca };
  if (original)
    return aplicarNaOriginal(admin, sessao.organizationId, (original as { id: string }).id, e);

  const tipoDaPendencia = PENDENCIA_DE_ALTERACAO[e.acao];
  const { data: jaGuardada, error: erroDaPendencia } = await admin
    .from("webhook_events_log")
    .select("id")
    .eq("organization_id", sessao.organizationId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .eq("event_type", tipoDaPendencia)
    .eq("external_id", e.originalId)
    .eq("payload_parsed->>id", e.externalId)
    .limit(1);
  if (erroDaPendencia)
    return { status: "falhou", tabela: "webhook_events_log", erro: erroDaPendencia };
  if (Array.isArray(jaGuardada) && jaGuardada.length > 0) return { status: "pendente_repetida" };

  const { error: erroAoGuardar } = await admin.from("webhook_events_log").insert({
    organization_id: sessao.organizationId,
    channel_session_id: sessao.id,
    provider: CHANNEL_PROVIDER_META,
    http_method: "POST",
    raw_body: JSON.stringify(e.bruto),
    // O item cru no topo (é o `payload_parsed->>id` da deduplicação) e, ao lado,
    // quem fez a alteração — a releitura precisa saber se foi o contato ou a empresa.
    payload_parsed: { ...e.bruto, _origem: e.origem },
    valid_signature: true,
    event_type: tipoDaPendencia,
    external_id: e.originalId,
    status: "received",
  });
  if (erroAoGuardar) return { status: "falhou", tabela: "webhook_events_log", erro: erroAoGuardar };
  logger.info("[meta.alteracao] mensagem original ainda não está no CRM — alteração guardada", {
    organization_id: sessao.organizationId,
    channel_session_id: sessao.id,
    acao: e.acao,
    origem: e.origem,
  });
  return { status: "pendente" };
}

/**
 * Depois que uma mensagem é gravada (ou reconhecida como duplicata), aplica as
 * alterações que chegaram antes dela, na ordem em que aconteceram. Cada
 * pendência aplicada vira `processed`. Devolve o erro do banco, ou `null`.
 */
export async function aplicarAlteracoesPendentes(
  admin: Admin,
  alvo: { organizationId: string; externalId: string },
): Promise<{ aplicadas: number; erro: ErroDoBancoLike | null }> {
  const { data: pendencias, error } = await admin
    .from("webhook_events_log")
    .select("id, event_type, payload_parsed")
    .eq("organization_id", alvo.organizationId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .eq("external_id", alvo.externalId)
    .eq("status", "received")
    .in("event_type", [PENDENCIA_DE_ALTERACAO.revoke, PENDENCIA_DE_ALTERACAO.edit]);
  if (error) return { aplicadas: 0, erro: error };
  // O filtro do banco já garante isto; conferir de novo custa nada e impede que
  // uma linha que não é pendência de alteração seja fechada como se fosse.
  const tiposDePendencia: string[] = [PENDENCIA_DE_ALTERACAO.revoke, PENDENCIA_DE_ALTERACAO.edit];
  const linhas = (
    (pendencias ?? []) as Array<{
      id: string;
      event_type?: string | null;
      payload_parsed: Record<string, unknown> | null;
    }>
  ).filter((l) => typeof l.event_type === "string" && tiposDePendencia.includes(l.event_type));
  if (linhas.length === 0) return { aplicadas: 0, erro: null };

  const alteracoes = linhas
    .map((l) => {
      const item = l.payload_parsed ?? {};
      const quem = item._origem === "empresa" ? "empresa" : "contato";
      return { id: l.id, e: alteracaoDaMensagem(item, { wabaId: "", phoneNumberId: "", quem }) };
    })
    .sort((a, b) => (a.e?.sentAt.getTime() ?? 0) - (b.e?.sentAt.getTime() ?? 0));

  let aplicadas = 0;
  for (const { id, e } of alteracoes) {
    if (e) {
      const { data: original, error: erroDaBusca } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", alvo.organizationId)
        .eq("external_id", alvo.externalId)
        .maybeSingle();
      if (erroDaBusca) return { aplicadas, erro: erroDaBusca };
      if (!original) return { aplicadas, erro: null };
      const r = await aplicarNaOriginal(
        admin,
        alvo.organizationId,
        (original as { id: string }).id,
        e,
      );
      if (r.status === "falhou") return { aplicadas, erro: r.erro };
      if (r.status === "aplicada") aplicadas += 1;
    }
    const { error: erroAoFechar } = await admin
      .from("webhook_events_log")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("organization_id", alvo.organizationId)
      .eq("id", id);
    if (erroAoFechar) return { aplicadas, erro: erroAoFechar };
  }
  return { aplicadas, erro: null };
}
