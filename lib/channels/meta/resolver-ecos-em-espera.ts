/**
 * O resolvedor dos ecos em espera de UMA janela (organização, canal, onboarding).
 *
 * Chamado pelo handler do evento `meta.historico.chunk_guardado` (a cada pedaço de
 * history guardado) e pelo cron `meta-ecos-em-espera`, a cada 5 minutos — que é a
 * rede contra evento perdido e o único que alcança o eco chegado DEPOIS do
 * history.
 *
 * ─── As decisões ────────────────────────────────────────────────────────────
 *   A. o wamid é `media_placeholder` `from_me` no history da janela → `historico`,
 *      na hora e para sempre. NÃO vira mensagem: a mídia fica guardada para o
 *      importador de history, que é o único que cria mensagem histórica.
 *   B. o history TERMINOU e o wamid não apareceu → `promovido`: o eco entra pelo
 *      caminho ao vivo, com `tardio: true` (sem pausar a IA por resposta antiga,
 *      sem carimbar a conversa com mensagem mais velha que a última).
 *   C. o history não terminou → continua `aguardando`.
 *   D. o wamid já era mensagem → `duplicado` (o `unique` de `messages` decide).
 *
 * ─── Corrida ────────────────────────────────────────────────────────────────
 * Toda transição parte de um estado e o exige na própria escrita (`where estado =
 * …`). Dois resolvedores na mesma janela: um reivindica, o outro não acha nada. A
 * correlação (SQL) só toca `aguardando`, então nunca reclassifica um eco que já
 * está sendo promovido, e a promoção só reivindica `aguardando`, então nunca
 * promove um eco já classificado como histórico.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

import type { AlvoDosEcos } from "./ecos-em-espera";
import { ingerirEcoAoVivo } from "./ingest-eco";
import { PRAZO_DA_SINCRONIZACAO_MS } from "./sincronizacao";
import { ecoDoItem } from "./webhook";

type Admin = SupabaseClient;

/** Sem pedaço novo há mais que isto, o history que já veio é tudo o que virá. */
export const HISTORICO_PARADO_MS = 6 * 60 * 60 * 1000;

/** Teto absoluto da espera, contado do onboarding: depois disto, promove o que sobrou. */
export const TETO_DA_ESPERA_MS = 7 * 24 * 60 * 60 * 1000;

/** Uma promoção reivindicada e não concluída há mais que isto foi abandonada (processo caiu). */
export const PROMOCAO_ABANDONADA_MS = 5 * 60 * 1000;

/** Teto de ecos promovidos por rodada — a rodada seguinte pega o resto. */
const LOTE_DA_PROMOCAO = 200;

/** Marca do `motivo` enquanto a promoção está em curso. */
const EM_CURSO = "promovendo:";

export interface FimDoHistorico {
  terminou: boolean;
  motivo: string;
}

/**
 * O history desta janela terminou? Exatamente os quatro critérios da revisão
 * aprovada, o primeiro que ocorrer:
 *   1. chegou um pedaço com `phase = 2` e `progress = 100`;
 *   2. o pedido de history da janela está num estado FINAL: `recusada`,
 *      `expirada`, ou `falhou` depois do prazo de pedir (`PRAZO_DA_SINCRONIZACAO_MS`
 *      contado do onboarding). Dentro do prazo, `falhou` NÃO é fim: a reserva de
 *      `sincronizacao.ts` aceita `falhou` de novo, e um novo pedido traz o history
 *      que provaria o eco histórico — promovê-lo antes seria irreversível, porque
 *      a correlação só reclassifica `aguardando`;
 *   3. houve pedaço, e nenhum novo chega há mais de `HISTORICO_PARADO_MS`;
 *   4. teto: `onboarding_em + TETO_DA_ESPERA_MS`.
 *
 * Um pedido `falhou` dentro do prazo, ou `solicitando` de novo, cai nos critérios
 * dos pedaços (1 e 3) e, sem pedaço nenhum, espera — até o novo ciclo terminar ou
 * o prazo de pedir vencer.
 *
 * A semântica de `phase = 2` + `progress = 100` como fim foi INFERIDA dos dados
 * (fase 0: um pedaço até 100; fase 1: pedaços até 100; fase 2 por último) e não
 * está confirmada na documentação da Meta. Se estiver errada, o custo é só
 * esperar mais — pelo critério 3 ou 4 —, nunca perder o eco.
 */
export async function historicoTerminou(admin: Admin, alvo: AlvoDosEcos, agora: Date): Promise<FimDoHistorico> {
  const onboarding = Date.parse(alvo.onboardingEm);
  if (agora.getTime() > onboarding + TETO_DA_ESPERA_MS) return { terminou: true, motivo: "teto_da_espera" };

  const { data: pedido, error: erroDoPedido } = await admin
    .from("meta_sincronizacoes")
    .select("status")
    .eq("organization_id", alvo.organizationId)
    .eq("channel_session_id", alvo.channelSessionId)
    .eq("onboarding_em", alvo.onboardingEm)
    .eq("tipo", "historico")
    .maybeSingle();
  if (erroDoPedido) throw new Error(`meta_sincronizacoes: ${erroDoPedido.message}`);
  const status = (pedido as { status?: string } | null)?.status ?? null;
  if (status === "recusada" || status === "expirada") {
    return { terminou: true, motivo: `historico_${status}` };
  }
  // `falhou` só é final quando ninguém mais pode pedir: a mesma régua (`agora >
  // prazo`) com que `solicitarSincronizacaoDoApp` deixa de chamar a Meta.
  if (status === "falhou" && agora.getTime() > onboarding + PRAZO_DA_SINCRONIZACAO_MS) {
    return { terminou: true, motivo: "historico_falhou" };
  }

  // Os critérios dos pedaços são duas PERGUNTAS ao banco, nunca a leitura da
  // janela inteira: o PostgREST corta toda resposta em `max_rows` (1000), e uma
  // janela com mais pedaços que isso seria decidida por um recorte arbitrário —
  // sem o pedaço de fim, ou com um "último pedaço" que não é o último, o que faria
  // o critério das 6h disparar com o history ainda chegando. Cada pergunta devolve
  // no máximo UMA linha, em ordem determinística, e erro de leitura LANÇA (nunca
  // vira "terminou").
  const pedacosDaJanela = (colunas: string) =>
    admin
      .from("meta_sincronizacao_payloads")
      .select(colunas)
      .eq("organization_id", alvo.organizationId)
      .eq("channel_session_id", alvo.channelSessionId)
      .eq("onboarding_em", alvo.onboardingEm)
      .eq("campo", "history");

  // 1. Existe o pedaço de fim (fase 2, progresso 100)?
  const { data: pedacoDeFim, error: erroDoFim } = await pedacosDaJanela("id").eq("fase", 2).eq("progresso", 100).limit(1);
  if (erroDoFim) throw new Error(`meta_sincronizacao_payloads: ${erroDoFim.message}`);
  if (((pedacoDeFim ?? []) as unknown[]).length > 0) return { terminou: true, motivo: "historico_completo" };

  // 3. O pedaço mais recente da janela — o `id` desempata o mesmo instante.
  const { data: maisRecente, error: erroDoUltimo } = await pedacosDaJanela("id, recebido_em")
    .order("recebido_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (erroDoUltimo) throw new Error(`meta_sincronizacao_payloads: ${erroDoUltimo.message}`);
  const ultimoPedaco = ((maisRecente ?? []) as unknown as Array<{ recebido_em: string }>)[0];
  if (!ultimoPedaco) return { terminou: false, motivo: "aguardando_primeiro_pedaco" };
  const ultimo = Date.parse(ultimoPedaco.recebido_em);
  if (!Number.isFinite(ultimo)) throw new Error(`meta_sincronizacao_payloads: recebido_em ilegível (${ultimoPedaco.recebido_em})`);
  return agora.getTime() - ultimo > HISTORICO_PARADO_MS
    ? { terminou: true, motivo: "historico_parado" }
    : { terminou: false, motivo: "historico_em_andamento" };
}

export interface ResultadoDaResolucao {
  historico: number;
  promovidos: number;
  duplicados: number;
  falhas: number;
  aguardando: number;
  fim: FimDoHistorico | null;
}

interface EcoGuardado {
  id: string;
  external_id: string;
  phone_number_id: string;
  waba_id: string | null;
  bruto: Record<string, unknown>;
}

const COLUNAS = "id, external_id, phone_number_id, waba_id, bruto";

export async function resolverEcosEmEspera(
  admin: Admin,
  alvo: AlvoDosEcos,
  agora: Date = new Date(),
): Promise<ResultadoDaResolucao> {
  const resultado: ResultadoDaResolucao = { historico: 0, promovidos: 0, duplicados: 0, falhas: 0, aguardando: 0, fim: null };

  // A. Correlação por wamid, numa passada pelo history da janela.
  const { data: classificados, error: erroDaCorrelacao } = await admin.rpc("fn_meta_ecos_correlacionar" as never, {
    p_org: alvo.organizationId,
    p_sessao: alvo.channelSessionId,
    p_onboarding: alvo.onboardingEm,
  } as never);
  if (erroDaCorrelacao) throw new Error(`fn_meta_ecos_correlacionar: ${(erroDaCorrelacao as { message: string }).message}`);
  resultado.historico = ((classificados ?? []) as unknown[]).length;

  // Promoção reivindicada e largada no meio (o processo caiu entre o claim e a
  // ingestão): refaz. A ingestão é idempotente pelo wamid.
  const { data: largados, error: erroDosLargados } = await admin
    .from("meta_ecos_em_espera")
    .select(`${COLUNAS}, motivo`)
    .eq("organization_id", alvo.organizationId)
    .eq("channel_session_id", alvo.channelSessionId)
    .eq("onboarding_em", alvo.onboardingEm)
    .eq("estado", "promovido")
    .like("motivo", `${EM_CURSO}%`)
    .lt("decidido_em", new Date(agora.getTime() - PROMOCAO_ABANDONADA_MS).toISOString())
    .order("decidido_em", { ascending: true })
    .order("id", { ascending: true })
    .limit(LOTE_DA_PROMOCAO);
  if (erroDosLargados) throw new Error(`meta_ecos_em_espera: ${erroDosLargados.message}`);
  for (const eco of (largados ?? []) as Array<EcoGuardado & { motivo: string }>) {
    await concluirPromocao(admin, alvo, eco, eco.motivo.slice(EM_CURSO.length), agora, resultado, { retomada: true });
  }

  const { data: pendentes, error: erroDosPendentes } = await admin
    .from("meta_ecos_em_espera")
    .select(COLUNAS)
    .eq("organization_id", alvo.organizationId)
    .eq("channel_session_id", alvo.channelSessionId)
    .eq("onboarding_em", alvo.onboardingEm)
    .eq("estado", "aguardando")
    .order("sent_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(LOTE_DA_PROMOCAO);
  if (erroDosPendentes) throw new Error(`meta_ecos_em_espera: ${erroDosPendentes.message}`);
  const lista = (pendentes ?? []) as EcoGuardado[];

  if (lista.length > 0) {
    // C. History em curso: espera.
    const fim = await historicoTerminou(admin, alvo, agora);
    resultado.fim = fim;
    if (!fim.terminou) {
      resultado.aguardando = lista.length;
    } else {
      // B. History terminou sem o wamid: promove, um por um, com claim.
      for (const eco of lista) {
        const { data: reivindicado, error: erroDoClaim } = await admin
          .from("meta_ecos_em_espera")
          .update({ estado: "promovido", motivo: `${EM_CURSO}${fim.motivo}`, decidido_em: agora.toISOString() })
          .eq("organization_id", alvo.organizationId)
          .eq("id", eco.id)
          .eq("estado", "aguardando")
          .select("id");
        if (erroDoClaim) throw new Error(`meta_ecos_em_espera: ${erroDoClaim.message}`);
        if (((reivindicado ?? []) as unknown[]).length === 0) continue; // outro resolvedor chegou antes
        await concluirPromocao(admin, alvo, eco, fim.motivo, agora, resultado, { retomada: false });
      }
    }
  }

  auditar(alvo, resultado);
  return resultado;
}

/** Passa o eco reivindicado pelo caminho ao vivo e grava o desfecho. */
async function concluirPromocao(
  admin: Admin,
  alvo: AlvoDosEcos,
  eco: EcoGuardado,
  motivo: string,
  agora: Date,
  resultado: ResultadoDaResolucao,
  opcoes: { retomada: boolean },
): Promise<void> {
  const fechar = (patch: Record<string, unknown>) =>
    admin
      .from("meta_ecos_em_espera")
      .update(patch)
      .eq("organization_id", alvo.organizationId)
      .eq("id", eco.id)
      .eq("estado", "promovido");

  const e = ecoDoItem(eco.bruto, { wabaId: eco.waba_id ?? "", phoneNumberId: eco.phone_number_id });
  if (!e) {
    // Não acontece pela porta de entrada (o parser só guarda eco com id e
    // destinatário), mas um bruto ilegível não pode girar para sempre.
    await fechar({ motivo: "bruto_ilegivel" });
    resultado.falhas += 1;
    return;
  }

  let desfecho: Awaited<ReturnType<typeof ingerirEcoAoVivo>>;
  try {
    desfecho = await ingerirEcoAoVivo(admin, e, { id: alvo.channelSessionId, organization_id: alvo.organizationId }, { tardio: true, agora });
  } catch (err) {
    desfecho = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  // Na RETOMADA, `duplicate` é a própria tentativa anterior, que gravou a mensagem
  // e caiu antes de fechar o estado — é promoção, não duplicata.
  if (desfecho.status === "ingested" || (opcoes.retomada && desfecho.status === "duplicate")) {
    await fechar({ motivo });
    resultado.promovidos += 1;
  } else if (desfecho.status === "duplicate") {
    await fechar({ estado: "duplicado", motivo: "wamid_ja_era_mensagem" });
    resultado.duplicados += 1;
  } else if (desfecho.status === "ignored") {
    await fechar({ motivo: `ignorado:${desfecho.reason}` });
    resultado.promovidos += 1;
  } else {
    // Falhou: volta a esperar, para a próxima rodada tentar de novo.
    const razao = desfecho.status === "failed" ? desfecho.reason : desfecho.status;
    await fechar({ estado: "aguardando", motivo: `falha:${razao}`.slice(0, 300), decidido_em: null });
    resultado.falhas += 1;
    logger.warn("[meta.eco] promoção de eco em espera falhou — volta a esperar", {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      external_id: eco.external_id,
      detalhe: razao.slice(0, 160),
    });
  }
}

/** Rodada que não decidiu nada não audita; a que decidiu, audita. */
function auditar(alvo: AlvoDosEcos, r: ResultadoDaResolucao): void {
  const base = { channel_session_id: alvo.channelSessionId, onboarding_em: alvo.onboardingEm };
  if (r.historico > 0) {
    void audit({
      action: "meta.eco_historico_classificado",
      organizationId: alvo.organizationId,
      bypassedRls: true,
      metadata: { ...base, quantidade: r.historico },
    });
  }
  if (r.promovidos + r.duplicados > 0) {
    void audit({
      action: "meta.eco_tardio_promovido",
      organizationId: alvo.organizationId,
      bypassedRls: true,
      metadata: { ...base, promovidos: r.promovidos, duplicados: r.duplicados, motivo: r.fim?.motivo ?? null },
    });
  }
}
