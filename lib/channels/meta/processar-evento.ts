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
import { aplicarAlteracaoDaMensagem } from "@/lib/channels/meta/alteracao-de-mensagem";
import { lerEnvelopeMeta } from "@/lib/channels/meta/envelope";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import {
  classeDaIngestao,
  classificarFalhaDoBanco,
  type ClasseDaFalha,
  type ErroDoBancoLike,
} from "@/lib/channels/falha-do-banco";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { ingestMetaEcho } from "@/lib/channels/meta/ingest-eco";
import { guardarPayloadDeSincronizacao } from "@/lib/channels/meta/sincronizacao";
import type { MetaWebhookSession } from "@/lib/channels/meta/session";
import {
  EVENTO_DE_RECONEXAO_DA_CONTA,
  ehDesconexaoDaConta,
  parseMetaWebhook,
  verifyMetaSignature,
  type AccountUpdateEvent,
  type MetaWebhookEvent,
} from "@/lib/channels/meta/webhook";
import { nomeDoCanal } from "@/lib/channels/estado";
import { PREFIXO_DESCONECTADO_NO_PROVEDOR, sincronizarSaudeDaConexao } from "@/lib/channels/health";
import type { SupabaseClient } from "@supabase/supabase-js";
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
    // Só identificadores: nem a assinatura, nem o corpo (não autenticado).
    logger.warn("[meta.webhook] entrega recusada: assinatura inválida", {
      request_id: requestId,
      rota: "universal",
      status: 401,
      assinatura_presente: Boolean(assinatura),
      app_secret_configurado: Boolean(appSecret),
      content_length: Buffer.byteLength(rawBody, "utf8"),
    });
    return { ok: false, status: 401, codigo: "unauthorized", mensagem: "invalid_signature" };
  }

  const leitura = lerEnvelopeMeta(rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      logger.warn("[meta.webhook] entrega recusada: JSON inválido", {
        request_id: requestId,
        rota: "universal",
        status: 400,
        content_length: Buffer.byteLength(rawBody, "utf8"),
      });
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
 * O evento NÃO foi gravado e a causa é passageira (banco fora, timeout): a rota
 * responde 503 para a Meta reentregar. Reentregar é seguro — a mensagem só entra
 * uma vez (`unique (organization_id, external_id)`), contato e conversa são
 * upserts, e status são atualizações que reaplicadas dão no mesmo.
 */
export const DESFECHO_PEDE_REENTREGA = "failed_retryable";

/**
 * O evento NÃO foi gravado por defeito ou configuração do CRM (migration
 * faltando, coluna inexistente, permissão) — ou foi recusado e nem o arquivo cru
 * entrou. A rota responde 500: nunca 200, porque o evento não está durável em
 * lugar nenhum. A reentrega da Meta (até 7 dias) é a janela para o conserto.
 */
export const DESFECHO_FALHA_DO_CRM = "failed_crm";

/** Os dois desfechos que impedem o 200. A rota usa a mais grave das duas. */
export function respostaPedida(desfecho: string | null): 503 | 500 | null {
  if (desfecho === DESFECHO_FALHA_DO_CRM) return 500;
  if (desfecho === DESFECHO_PEDE_REENTREGA) return 503;
  return null;
}

/**
 * Guarda o evento recusado POR SEU PRÓPRIO DADO em `webhook_events_log` — o
 * arquivo cru que o produto já mantém (retenção, RLS por organização). É isso
 * que torna o 200 honesto: a Meta para de reentregar, mas o evento continua
 * consultável e reprocessável depois de um conserto.
 *
 * Um evento por linha, e nunca a entrega inteira: no webhook universal uma
 * entrega pode trazer eventos de várias organizações, e cada linha leva o
 * `organization_id` da sessão dona do evento. Devolve o erro do banco, ou `null`.
 */
export async function arquivarEventoRecusado(
  admin: Admin,
  e: MetaWebhookEvent,
  sessao: MetaWebhookSession,
  motivo: string,
): Promise<ErroDoBancoLike | null> {
  try {
    const cru = JSON.stringify(e);
    const { error } = await admin.from("webhook_events_log").insert({
      organization_id: sessao.organizationId,
      channel_session_id: sessao.id,
      provider: CHANNEL_PROVIDER_META,
      http_method: "POST",
      raw_body: cru,
      payload_parsed: JSON.parse(cru) as Record<string, unknown>,
      valid_signature: true,
      event_type: e.kind,
      external_id: "externalId" in e ? (e.externalId ?? null) : null,
      status: "error",
      error_message: `do_evento: ${motivo}`.slice(0, 500),
      processed_at: new Date().toISOString(),
    });
    return error ?? null;
  } catch (err) {
    return { code: "", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * O que uma ingestão que FALHOU pede à rota, pela classe da falha:
 * `transitoria` → reentrega (503); `estrutural` → falha do CRM (500);
 * `do_evento` → arquiva o evento cru e segue com o status (`failed`, 200) — e,
 * se nem o arquivo entrar, volta a pedir 5xx pela classe da falha do arquivo.
 */
export async function desfechoDaFalhaDeIngestao(
  admin: Admin,
  e: MetaWebhookEvent,
  sessao: MetaWebhookSession,
  r: { status: string; reason?: string; classe?: ClasseDaFalha },
): Promise<string> {
  const classe = classeDaIngestao(r);
  if (classe === null) return r.status;
  if (classe === "transitoria") return DESFECHO_PEDE_REENTREGA;
  if (classe === "estrutural") return DESFECHO_FALHA_DO_CRM;

  const erroDoArquivo = await arquivarEventoRecusado(admin, e, sessao, r.reason ?? "sem_motivo");
  if (!erroDoArquivo) return r.status;
  logger.error("[meta.webhook] evento recusado e o arquivo cru também falhou — não confirmado", {
    organization_id: sessao.organizationId,
    channel_session_id: sessao.id,
    kind: e.kind,
    codigo: erroDoArquivo.code ?? null,
    erro: (erroDoArquivo.message ?? "").replace(/\s+/g, " ").slice(0, 200),
  });
  return classificarFalhaDoBanco(erroDoArquivo) === "transitoria" ? DESFECHO_PEDE_REENTREGA : DESFECHO_FALHA_DO_CRM;
}

/**
 * Processa UM evento para a sessão dona dele. Toda escrita leva o
 * `organization_id` da sessão — nunca do corpo.
 *
 * Devolve o desfecho da ingestão de mensagem recebida ou de eco do app Business
 * (vai para `outcomes` na resposta), `"waba_divergente"` quando o evento não é desta sessão,
 * `DESFECHO_PEDE_REENTREGA` / `DESFECHO_FALHA_DO_CRM` quando a gravação falhou e o evento
 * não está durável (ver `respostaPedida`), e `null` para
 * os demais eventos, que não têm desfecho próprio.
 */
export async function processarEventoDaMeta(
  admin: Admin,
  e: MetaWebhookEvent,
  sessao: MetaWebhookSession,
  agora: string,
): Promise<string | null> {
  // O evento chega carimbado com a WABA; se não for a desta sessão, não é dela.
  if (sessao.wabaId && e.wabaId && e.wabaId !== sessao.wabaId) {
    logger.warn("[meta.webhook] evento descartado: WABA do evento difere da do canal", {
      rota: "universal",
      motivo: "waba_divergente",
      kind: e.kind,
      ...(e.kind === "sync_payload" ? { campo: e.campo } : {}),
      waba_do_evento: e.wabaId,
      waba_do_canal: sessao.wabaId,
      organization_id: sessao.organizationId,
      channel_session_id: sessao.id,
    });
    return "waba_divergente";
  }

  if (e.kind === "inbound_message") {
    // Mensagem do contato vira linha no inbox, move lead, acorda o agente e
    // carimba `last_inbound_at` — que é o que ABRE a janela de 24h.
    const r = await ingestMetaInbound(admin, e, { organizationId: sessao.organizationId });
    if (r.status === "failed" || r.status === "no_session") {
      // Falha permanente: 2xx continua (a Meta re-entregaria em loop um corpo que
      // nunca melhora), mas a falha NÃO fica muda. Falha passageira: 5xx.
      logger.error("[meta.ingest] inbound não ingerido", {
        status: r.status,
        reason: r.status === "failed" ? r.reason : undefined,
        classe: classeDaIngestao(r),
        external_id: e.externalId,
        phone_number_id: e.phoneNumberId,
        organization_id: sessao.organizationId,
      });
    }
    return desfechoDaFalhaDeIngestao(admin, e, sessao, r);
  }

  if (e.kind === "echo_message") {
    // O dono respondeu pelo app WhatsApp Business (coexistência): a linha entra
    // como saída feita fora do CRM e a IA pausa nessa conversa.
    const r = await ingestMetaEcho(admin, e, { organizationId: sessao.organizationId });
    if (r.status === "failed" || r.status === "no_session") {
      logger.error("[meta.eco] eco do app Business não ingerido", {
        status: r.status,
        reason: r.status === "failed" ? r.reason : undefined,
        classe: classeDaIngestao(r),
        external_id: e.externalId,
        phone_number_id: e.phoneNumberId,
        organization_id: sessao.organizationId,
      });
    }
    return desfechoDaFalhaDeIngestao(admin, e, sessao, r);
  }

  if (e.kind === "sync_payload") {
    // Sincronização do app (coexistência): só GUARDA o payload bruto. Nada vira
    // mensagem, conversa ou contato — ver `lib/channels/meta/sincronizacao.ts`.
    return guardarPayloadDeSincronizacao(admin, e, { organizationId: sessao.organizationId });
  }

  if (e.kind === "account_update") return aplicarMudancaDaConta(admin, e, sessao, agora);

  if (e.kind === "message_change") {
    // Mensagem apagada ou editada — pelo contato ou pela empresa no app. Atualiza
    // a original desta organização, ou guarda para quando ela chegar.
    const r = await aplicarAlteracaoDaMensagem(admin as unknown as SupabaseClient, e, sessao);
    if (r.status !== "falhou") return `alteracao_${r.status}`;
    return desfechoDaAtualizacao(r.erro, r.tabela, sessao) ?? `alteracao_recusada`;
  }

  if (e.kind === "template_status") {
    const { error } = await admin
      .from("meta_templates")
      .update({ status: e.event, rejected_reason: e.reason, updated_at: agora })
      .eq("organization_id", sessao.organizationId)
      .eq("waba_id", e.wabaId)
      .eq("name", e.templateName)
      .eq("language", e.templateLanguage);
    return desfechoDaAtualizacao(error, "meta_templates", sessao);
  }

  const atualizacao = admin
    .from("messages")
    .update({ status: e.status === "failed" ? "failed" : "sent", updated_at: agora })
    .eq("organization_id", sessao.organizationId)
    .eq("external_id", e.externalId);
  // `failed` é TERMINAL: nenhum status posterior a desfaz. Sem esta guarda, a
  // reentrega da Meta reordena os estados — o "sent" que levou 503 com o banco
  // fora volta DEPOIS do "failed" já gravado e o apaga, e a mensagem que não
  // chegou aparece como enviada. Ver `naoDesfazFalha`.
  const { error } = await (e.status === "failed" ? atualizacao : naoDesfazFalha(atualizacao));
  return desfechoDaAtualizacao(error, "messages", sessao);
}

/**
 * A guarda de ordem dos status de entrega, igual nas duas rotas: um status que
 * não é `failed` só atualiza mensagem que ainda não falhou.
 *
 * Por que a ordem importa agora: desde que o webhook responde 503 quando o banco
 * falha, a Meta REENTREGA — e a reentrega chega depois de entregas mais novas.
 * Sem timestamp do evento guardado na mensagem, a única ordem que dá para
 * garantir é a dos estados: `failed` não volta atrás. Linha já `failed` = zero
 * linhas atualizadas, sem erro, e o webhook confirma (o evento é obsoleto, não
 * perdido).
 */
export function naoDesfazFalha<T extends { neq: (coluna: string, valor: string) => T }>(consulta: T): T {
  return consulta.neq("status", "failed");
}

/**
 * Atualização de estado (modelo, entrega) que o banco recusou. O `{ error }` era
 * descartado: com o banco fora, o "entregue"/"lido"/"falhou" da Meta sumia com
 * 200. Passageira → 503 (reaplicar dá no mesmo); estrutural → 500; recusa do
 * próprio dado → log e 200 (um estado de entrega não é a mensagem do cliente, e
 * reentregar o mesmo valor não muda o desfecho).
 */
export function desfechoDaAtualizacao(
  error: ErroDoBancoLike | null,
  tabela: string,
  sessao: MetaWebhookSession,
): string | null {
  const classe = classificarFalhaDoBanco(error);
  if (!error || classe === null) return null;
  logger.error("[meta.webhook] atualização de estado não gravada", {
    tabela,
    classe,
    codigo: error.code ?? null,
    erro: (error.message ?? "").replace(/\s+/g, " ").slice(0, 200),
    organization_id: sessao.organizationId,
    channel_session_id: sessao.id,
  });
  if (classe === "transitoria") return DESFECHO_PEDE_REENTREGA;
  if (classe === "estrutural") return DESFECHO_FALHA_DO_CRM;
  return null;
}

/**
 * A conta se desconectou (ou voltou) — o estado da CONEXÃO passa a refletir o
 * que a Meta disse.
 *
 * Desconexão: `status = STOPPED` e aviso crítico na Central, marcado como
 * EMPURRÃO para a varredura não fechá-lo (nem pôr "Conectado" de volta — ver o
 * cron `channel-health`) enquanto o número segue fora. A linha NÃO é apagada
 * nem arquivada: histórico, conversas e modelos continuam presos a ela, e
 * reconectar o mesmo número a reaproveita.
 *
 * Reconexão: fecha o aviso. O `status` volta a `WORKING` pela varredura, que
 * pergunta ao número — a reconexão da conta sozinha não prova que o número
 * voltou a responder.
 */
async function aplicarMudancaDaConta(
  admin: Admin,
  e: AccountUpdateEvent,
  sessao: MetaWebhookSession,
  agora: string,
): Promise<string | null> {
  const desconectou = ehDesconexaoDaConta(e.event);
  const reconectou = e.event === EVENTO_DE_RECONEXAO_DA_CONTA;
  if (!desconectou && !reconectou) return null;

  // Os `{ error }` daqui eram descartados: com o banco fora, a desconexão da
  // conta respondia 200, a Meta não reenviava, e o canal seguia "Conectado" com
  // o número fora da API. Agora a leitura e o `update` passam pela mesma régua
  // dos outros estados (`desfechoDaAtualizacao`): passageira → 503, estrutural
  // → 500. Reaplicar é seguro: o `update` reescreve o mesmo `STOPPED`, e o aviso
  // da Central deduplica pelo episódio.
  const { data: linha, error: erroDaLeitura } = await admin
    .from("channel_sessions")
    .select("display_name, phone_number")
    .eq("organization_id", sessao.organizationId)
    .eq("id", sessao.id)
    .maybeSingle();
  const pedidoDaLeitura = desfechoDaAtualizacao(erroDaLeitura, "channel_sessions", sessao);
  if (respostaPedida(pedidoDaLeitura)) return pedidoDaLeitura;
  const apelido = nomeDoCanal((linha as { display_name?: string | null; phone_number?: string | null } | null) ?? {});

  if (desconectou) {
    const { error: erroDoStatus } = await admin
      .from("channel_sessions")
      .update({ status: "STOPPED", last_status_change_at: agora })
      .eq("organization_id", sessao.organizationId)
      .eq("id", sessao.id);
    const pedidoDoStatus = desfechoDaAtualizacao(erroDoStatus, "channel_sessions", sessao);
    if (respostaPedida(pedidoDoStatus)) return pedidoDoStatus;
    const motivo = [e.event, e.reason, e.initiatedBy].filter(Boolean).join(" · ");
    const pedidoDoAviso = await sincronizarOuPedirReentrega(admin, sessao, () =>
      sincronizarSaudeDaConexao(
        admin as unknown as SupabaseClient,
        { id: sessao.id, organization_id: sessao.organizationId, status: "STOPPED" },
        { reachable: true, status: "STOPPED", detail: `${PREFIXO_DESCONECTADO_NO_PROVEDOR}${motivo}` },
        apelido,
        "empurrao",
      ),
    );
    if (pedidoDoAviso) return pedidoDoAviso;
    logger.warn("[meta.webhook] conta desconectada da API pela Meta", {
      organization_id: sessao.organizationId,
      channel_session_id: sessao.id,
      event: e.event,
      reason: e.reason,
      initiated_by: e.initiatedBy,
    });
    return "conta_desconectada";
  }

  const pedidoDoAviso = await sincronizarOuPedirReentrega(admin, sessao, () =>
    sincronizarSaudeDaConexao(
      admin as unknown as SupabaseClient,
      { id: sessao.id, organization_id: sessao.organizationId, status: "WORKING" },
      { reachable: true, status: "WORKING", detail: null },
      apelido,
      "empurrao",
    ),
  );
  if (pedidoDoAviso) return pedidoDoAviso;
  return "conta_reconectada";
}

/**
 * Roda a sincronização do aviso da Central e converte uma EXCEÇÃO dela no
 * desfecho que impede o 200: sem código de banco conta como passageira (503),
 * com código segue o classificador. `null` = sincronizou.
 *
 * LIMITE CONHECIDO: `sincronizarSaudeDaConexao` (`lib/channels/health.ts`)
 * descarta o `{ error }` das próprias escritas (o aviso em `agent_inbox_items`
 * e o episódio em `channel_session_health`) em vez de devolvê-lo ou lançar. O
 * que esta função alcança é a exceção; a falha de escrita do aviso só fica
 * visível quando aquela função passar a propagá-la.
 */
async function sincronizarOuPedirReentrega(
  admin: Admin,
  sessao: MetaWebhookSession,
  sincronizar: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await sincronizar();
    return null;
  } catch (err) {
    const codigo = (err as { code?: unknown } | null)?.code;
    const erro: ErroDoBancoLike = {
      code: typeof codigo === "string" ? codigo : "",
      message: err instanceof Error ? err.message : String(err),
    };
    return desfechoDaAtualizacao(erro, "agent_inbox_items", sessao) ?? DESFECHO_FALHA_DO_CRM;
  }
}
