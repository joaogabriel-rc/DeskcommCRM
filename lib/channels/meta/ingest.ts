/**
 * Ingestão de mensagem RECEBIDA pelo canal oficial — a metade que faltava.
 *
 * Sem ela o canal é um megafone: o cliente responde e nada chega, nenhum lead se
 * move, o agente não acorda, e a janela de 24h — que deriva de
 * `conversations.last_inbound_at` — nunca abre. O gate da Fase 4 vetaria para sempre
 * e o sistema só saberia falar por template.
 *
 * ─── Reusa as MESMAS operações canônicas do outro canal ─────────────────────
 * `fn_upsert_wa_contact` / `fn_upsert_wa_conversation` / `fn_mark_conversation_message`
 * já resolvem contato e conversa de forma atômica, e são agnósticas de provider. O
 * que muda aqui é só o mapeamento do payload — escrever uma segunda resolução de
 * contato seria criar a divergência que a migration 0027 (wa_identity canônica)
 * eliminou.
 *
 * ─── Duas armadilhas medidas contra a WABA real ─────────────────────────────
 * 1. **O `wa_id` pode vir sem o nono dígito** (`553198966398` para quem recebemos
 *    como `5531998966398`). A resolução do contato passa por `phoneLookupVariants`,
 *    senão a mesma pessoa vira dois cadastros e a conversa parte ao meio.
 * 2. **A Meta re-entrega tudo que não recebe 2xx.** A idempotência por
 *    `unique (organization_id, external_id)` não é higiene, é obrigatória: sem ela a
 *    mesma mensagem aparece N vezes no inbox depois de qualquer instabilidade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import {
  ehNumeroInternoDeAviso,
  registrarMensagemIgnorada,
} from "@/lib/escalacao/numero-interno-de-aviso";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { extrairAtribuicaoMeta } from "../atribuicao-de-anuncio-oficial";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { classificarFalhaDoBanco, type ClasseDaFalha } from "../falha-do-banco";
import { aplicarAlteracoesPendentes } from "./alteracao-de-mensagem";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import type { ChannelTenantScope } from "../types";
import type { InboundMessageEvent } from "./webhook";

type Admin = SupabaseClient;

export type IngestOutcome =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "no_session" }
  /**
   * Recusa DELIBERADA, e por isso um status próprio.
   *
   * `duplicate` diria "já ingerimos esta" e `failed` diria "tentamos e não deu"
   * — as duas são mentiras sobre o que aconteceu, e as duas mandam quem lê o log
   * procurar no lugar errado. Hoje o único motivo é `numero_interno_de_aviso`:
   * a mensagem veio do número que a própria equipe usa para receber os avisos de
   * atendimento, e por desenho nada que venha dele vira contato, conversa ou
   * despacho do agente. O `reason` existe para o próximo motivo não precisar de
   * um status novo.
   *
   * O chamador (a rota do webhook) só ramifica em `failed`/`no_session`, então
   * este valor entra sem mexer em decisão nenhuma lá.
   */
  | { status: "ignored"; reason: string }
  /**
   * `classe`: POR QUE a mensagem não foi gravada — e o que o webhook responde.
   * `transitoria` (banco fora) → 503; `estrutural` (schema/configuração do CRM)
   * → 500; `do_evento` (dado recusado) → 200 só depois de arquivar o evento cru.
   * Ver `lib/channels/falha-do-banco.ts` (`classeDaIngestao` lê este campo).
   */
  | { status: "failed"; reason: string; classe?: ClasseDaFalha };

/**
 * Sessão dona do número que RECEBEU, **dentro da organização do token**.
 *
 * O cabeçalho anterior já dizia "nunca confiamos no corpo para escolher
 * organização" — e a consulta fazia exatamente isso: `phoneNumberId` sai do
 * corpo do webhook e era o ÚNICO filtro. Duas organizações com o mesmo número
 * (configuração legítima: agência, migração entre organizações) faziam
 * `maybeSingle()` casar duas linhas, devolver `data: null` com `PGRST116` — e,
 * com o `error` descartado, a mensagem que acabou de chegar era descartada para
 * as DUAS, com a rota respondendo 200 (issue #236).
 *
 * A organização vem de `dono`, resolvido pela rota a partir do TOKEN DO PATH
 * (`metaSessionByWebhookToken`) — a mesma fonte confiável que já decide onde o
 * status de template e o status de mensagem são gravados nesse handler. O
 * número continua no filtro porque uma organização pode ter mais de um número
 * oficial, e é ele que diz QUAL sessão recebeu.
 *
 * Sessão ARQUIVADA não é dona de nada: o usuário excluiu o canal. Sem este
 * filtro, o desfecho `no_session` (que o chamador loga e devolve no corpo) vira
 * uma mensagem gravada num canal que já não existe para o operador.
 *
 * **LANÇA quando a consulta falha**, para o chamador gravar `failed` com o
 * motivo em vez de `no_session`. "Não achei" e "não consegui perguntar" pedem
 * ações diferentes do operador, e colapsá-los foi metade do defeito.
 */
export async function sessionByPhoneNumberId(
  admin: Admin,
  organizationId: string,
  phoneNumberId: string,
) {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id")
      .eq("organization_id", organizationId)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  // O `code` segue no `cause`: é por ele que quem chama decide entre pedir
  // reentrega (banco fora) e registrar falha permanente (schema/configuração).
  if (error) {
    throw new Error(`sessao_do_numero: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(), {
      cause: { code: error.code ?? "" },
    });
  }
  return data;
}

/**
 * A busca da sessão pelo número lançou: passageira ou do CRM. Nunca `do_evento`
 * — a consulta é nossa, o evento só deu o número; um 22xxx aqui é defeito do
 * CRM. Sem `code` (promessa rejeitada, rede) conta como passageira.
 */
export function classeDaBuscaDaSessao(err: unknown): ClasseDaFalha {
  const code = ((err as { cause?: unknown } | null)?.cause as { code?: unknown } | undefined)?.code;
  return classificarFalhaDoBanco({ code: typeof code === "string" ? code : "" }) === "transitoria"
    ? "transitoria"
    : "estrutural";
}

/**
 * Contato já existente sob QUALQUER variante do número. Só depois de não achar é que
 * deixamos o upsert criar — assim o cadastro nasce uma vez só.
 */
/**
 * Delega para `encontrarContatoPorTelefone`, que decide QUAL grafia vence.
 *
 * Era uma cópia local com `.in(variantes).limit(1)` — sem `order by`, e sem o
 * filtro de contato fundido. Três funções idênticas viviam assim no repo; a
 * regra agora mora num lugar só.
 */
async function findContactByVariants(
  admin: Admin,
  orgId: string,
  waId: string,
): Promise<{ id: string; phone_number: string } | null> {
  return encontrarContatoPorTelefone(admin as never, orgId, waId);
}

/**
 * O `metadata` de uma mensagem do canal oficial — a recebida e o eco.
 *
 * `meta_original` é o item como a Meta mandou, com todas as chaves, inclusive
 * as que este CRM ainda não lê: é o que permite entender depois uma mensagem
 * que entrou como rótulo. A anonimização LGPD zera `messages.metadata` inteiro
 * (`fn_lgpd_cascade_redact_contact`), então o original sai junto com o resto.
 */
export function metadataDaMeta(
  e: Pick<InboundMessageEvent, "media" | "sharedContact" | "bruto" | "extras" | "conteudoIndisponivel">,
): Record<string, unknown> {
  return {
    ...(e.extras ?? {}),
    ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}),
    ...(e.sharedContact ? { shared_contact: e.sharedContact } : {}),
    ...(e.conteudoIndisponivel ? { conteudo_indisponivel: true } : {}),
    ...(e.bruto ? { meta_original: e.bruto } : {}),
  };
}

/** A aplicação das alterações pendentes falhou: o mesmo desfecho de qualquer gravação. */
function falhaDasPendencias(erro: { code?: string | null; message?: string | null }): IngestOutcome {
  return {
    status: "failed",
    reason: `alteracoes_pendentes: ${erro.message ?? "sem mensagem"}`,
    classe: classificarFalhaDoBanco(erro) ?? "estrutural",
  };
}

/**
 * Prévia curta para a lista de conversas. Mídia vira rótulo, nunca URL. Serve à
 * recebida e ao eco do app Business, que têm o mesmo conteúdo.
 */
export function previewOf(e: Pick<InboundMessageEvent, "type" | "text" | "sharedContact" | "media">): string {
  if (e.type === "text") return (e.text ?? "").slice(0, 120);
  if (e.type === "contact") return e.sharedContact?.name ? `👤 ${e.sharedContact.name}` : "[contato]";
  if (e.type === "audio") return e.media?.voice ? "🎤 Mensagem de voz" : "🎵 Áudio";
  if (e.type === "image") return "📷 Imagem";
  if (e.type === "video") return "🎬 Vídeo";
  if (e.type === "document") return "📎 Documento";
  return `[${e.type}]`;
}

export async function ingestMetaInbound(
  admin: Admin,
  e: InboundMessageEvent,
  dono: ChannelTenantScope & {
    /**
     * A sessão JÁ resolvida pelo token do webhook, por quem chama. É o caminho
     * do canal parceiro que espelha a Cloud API (Datafy): ele entra pela rota
     * genérica, e a coluna do número oficial é NULL para ele — buscar por ela
     * nunca acharia a sessão. Quem passa isto já conferiu que o número é dela.
     */
    channelSessionId?: string;
  },
): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  if (dono.channelSessionId) {
    sessao = { id: dono.channelSessionId, organization_id: dono.organizationId };
  } else {
    try {
      sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
    } catch (err) {
      // Falhar FECHADO na ação (nada é gravado) e ABERTO na informação: o motivo
      // sobe como `failed` e o chamador o escreve no log e no corpo. Reentrega só
      // se a causa for passageira — erro de schema não melhora reentregando.
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : "sessao_do_numero",
        classe: classeDaBuscaDaSessao(err),
      };
    }
  }
  // Sem sessão: a mensagem é de um número que não administramos. Devolver 200 (o
  // chamador faz isso) evita a Meta re-entregar em loop algo que nunca vamos aceitar.
  if (!sessao) return { status: "no_session" };

  const orgId = sessao.organization_id;

  // ── O NÚMERO INTERNO DE AVISOS NÃO VIRA ATENDIMENTO ─────────────────────
  //
  // Antes do upsert do contato, que é o que importa: é o nascimento da conversa
  // que dispara o pedido de rodízio pelo banco. O identificador aqui chega só em
  // dígitos (`wa_id`), e o `+` é o que a comparação por variantes do nono dígito
  // espera — quem casa é a mesma regra dos outros dois ingestores.
  if (
    await ehNumeroInternoDeAviso(admin, orgId, {
      kind: "phone",
      phone: `+${e.from.replace(/\D/g, "")}`,
      lid: null,
    })
  ) {
    await registrarMensagemIgnorada(admin, orgId, {
      direction: "inbound",
      sessionId: sessao.id,
    });
    return { status: "ignored", reason: "numero_interno_de_aviso" };
  }

  const existente = await findContactByVariants(admin, orgId, e.from);
  // Celular BR grava COM o nono. A busca acima já reencontra a grafia sem o 9;
  // a RPC promove o cadastro antigo quando ainda está nos 12 dígitos.
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : canonicalPhoneBR(`+${e.from.replace(/\D/g, "")}`);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.from,
      p_notify: e.profileName,
    } as never,
  );
  if (erroContato || !contactId) {
    return {
      status: "failed",
      reason: `contato: ${erroContato?.message ?? "sem id"}`,
      classe: classificarFalhaDoBanco(erroContato) ?? "estrutural",
    };
  }

  // Clique em anúncio: o `referral` vem na própria mensagem e só nela. Estampar
  // AQUI, antes de `aplicarEfeitosPosEntrada`, porque é lá que o lead nasce. A
  // guarda de primeiro toque fica no banco, então a re-entrega não reescreve.
  const atribuicao = extrairAtribuicaoMeta(e.referral);
  if (atribuicao) await estamparAtribuicaoDoContato(admin, orgId, contactId as string, atribuicao);

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never,
  );
  if (erroConversa || !conversationId) {
    return {
      status: "failed",
      reason: `conversa: ${erroConversa?.message ?? "sem id"}`,
      classe: classificarFalhaDoBanco(erroConversa) ?? "estrutural",
    };
  }

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      // NOT NULL na tabela. Esquecê-lo fez o insert falhar e — porque a rota
      // descartava o resultado — a falha virou "recebido: 1" com nada gravado.
      channel_session_id: sessao.id,
      contact_id: contactId as string,
      direction: "inbound",
      status: "delivered",
      // A Meta manda `contacts` (plural); o CHECK do banco espera `contact`.
      type: e.type === "text" ? "text" : e.type,
      body: e.type === "contact" ? (e.sharedContact?.name ?? e.text) : e.text,
      external_id: e.externalId,
      // O webhook oficial entrega o media_id, não um arquivo que o browser
      // consiga abrir. Mantemos um ponteiro opaco para o adapter resolver pela
      // Graph API; sem ele a bolha nem é renderizada e o worker pula a mídia.
      media_url: e.media ? `meta-media:${e.media.id}` : null,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: metadataDaMeta(e),
    })
    .select("id")
    .maybeSingle();

  // 23505 = a mesma `external_id` já entrou. Não é erro: é a Meta re-entregando.
  // É também o que torna a reentrega segura: contato e conversa acima são upserts
  // (reaplicar não duplica), e esta linha é a primeira escrita que não se repete.
  if (erroInsert) {
    if (erroInsert.code === "23505") {
      // A reentrega também é a nova chance de aplicar um `revoke`/`edit` que
      // chegou antes da original e não pôde ser aplicado na primeira vez.
      const pendentes = await aplicarAlteracoesPendentes(admin, { organizationId: orgId, externalId: e.externalId });
      if (pendentes.erro) return falhaDasPendencias(pendentes.erro);
      return { status: "duplicate" };
    }
    return {
      status: "failed",
      reason: `mensagem: ${erroInsert.message}`,
      classe: classificarFalhaDoBanco(erroInsert) ?? "estrutural",
    };
  }

  // Carimba a conversa — é ISTO que move `last_message_at`, `last_inbound_at` e
  // abre a janela de 24h. Falha aqui não derruba a ingestão (a mensagem já
  // entrou), mas a prévia, a ordenação da Inbox e a janela ficariam paradas.
  //
  // ⚠️ O RETORNO ERA IGNORADO, e o comentário que estava aqui afirmava o
  // contrário — "o erro sobe como `failed` parcial no log do chamador em vez de
  // sumir". Sumia: era um `await` sem destino para o `{ error }`. O canal
  // oficial era o pior dos três justamente onde a falha dói mais, porque é ele
  // que tem janela de 24h — e conversa sem carimbo é janela que ninguém vê
  // fechar. Quem decide o que fazer com a falha agora é uma função só.
  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: conversationId as string,
    direction: "inbound",
    preview: previewOf(e),
    at: e.sentAt.toISOString(),
    canal: "meta",
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
      console.error(
        "[meta.ingest] emit media.persist_requested failed",
        erroPersistencia.message,
      );
    }
  }
  // Conteúdo que a Meta não entregou (`unsupported`, tipo desconhecido): a
  // mensagem fica registrada, mas o CRM só tem um RÓTULO dele mesmo — opt-out,
  // demanda e o despacho da IA não rodam sobre isso. Os handlers do `event_log`
  // que respondem ao conteúdo são barrados pela marca no evento (migration 9254).
  if (!e.conteudoIndisponivel) {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: orgId,
      contactId: contactId as string,
      conversationId: conversationId as string,
      messageId: messageId || null,
      channelSessionId: sessao.id,
      texto: e.text ?? null,
      nomeDoContato: e.profileName ?? null,
      origem: "meta_webhook",
    });
  }

  // `revoke`/`edit` que chegaram antes desta mensagem. Falha aqui pede reentrega:
  // a reentrega cai no 23505 acima e tenta de novo — os efeitos já rodaram.
  const pendentes = await aplicarAlteracoesPendentes(admin, { organizationId: orgId, externalId: e.externalId });
  if (pendentes.erro) return falhaDasPendencias(pendentes.erro);

  return {
    status: "ingested",
    messageId,
    conversationId: conversationId as string,
  };
}
