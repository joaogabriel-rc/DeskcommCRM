/**
 * O CATÁLOGO DE MODELOS APROVADOS — uma leitura só para toda tela que oferece
 * modelo: Conexões, o nó de mensagem dos Fluxos e, depois, os Disparos.
 *
 * ─── Por que uma camada, e não mais uma consulta ────────────────────────────
 *
 * `meta_templates` é lido em meia dúzia de lugares, cada um com o seu recorte:
 * a tela de Conexões pede tudo da organização, o envio confere por conexão, o
 * inbox pergunta pela conversa. Uma tela nova que escrevesse a própria consulta
 * seria a sétima — e a primeira a esquecer o recorte da conexão ofereceria um
 * modelo de OUTRA conta, que a plataforma recusa no envio. Aqui ficam as três
 * decisões que precisam ser iguais em todo lugar:
 *
 *   1. o ESCOPO: organização sempre; e, com conexão, só os modelos daquela
 *      conta (`escopoDaConexao`);
 *   2. o que é UTILIZÁVEL: a mesma régua do envio (`isStatusSendable`);
 *   3. a FORMA: contrato por `deriveTemplateContract`, chave de cada espaço por
 *      `slotKey` e conteúdo por `lerConteudo` — as mesmas funções que montam o
 *      payload de envio. Nada é recontado aqui.
 *
 * ─── O identificador ────────────────────────────────────────────────────────
 *
 * `id` é o uuid da linha do espelho. Ele SOBREVIVE ao sync: o upsert do sync é
 * por (organização, conta, nome, idioma) e atualiza a linha no lugar, e um modelo
 * que some da plataforma vira `DISABLED` em vez de ser apagado. Por isso é o id
 * que uma configuração guarda — nome e idioma vão junto como RETRATO, porque são
 * a chave que a plataforma usa no envio.
 *
 * ─── O que esta camada NÃO faz ──────────────────────────────────────────────
 *
 * Escrever. O espelho é projeção da plataforma e só o servidor o grava (sync e
 * webhooks, com admin client); desde a 0393 os papéis da tela nem têm o
 * privilégio. E não fala com a rede: quem sincroniza é `template-sync.ts`.
 *
 * ⚠️ Módulo de SERVIDOR (a normalização do motivo de recusa vem de
 * `meta/webhook.ts`, que usa `node:crypto`). O cliente importa daqui só TIPOS;
 * os ajudantes puros que a tela usa moram em `hooks/channels/useCatalogoDeModelos.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { slotKey } from "./meta/build-components";
import { isStatusSendable } from "./meta/template-binding";
import {
  deriveTemplateContract,
  describeAddress,
  type TemplateContract,
} from "./meta/template-contract";
import { mesclarValoresSalvos } from "./meta/valores-salvos";
import { normalizeRejectedReason } from "./meta/webhook";
import { lerConteudo } from "./template-conteudo";
import { fonteDeTemplates } from "./templates-fonte";

/** As colunas que o catálogo lê — uma lista só, para toda consulta concordar. */
const COLUNAS =
  "id, waba_id, channel_session_id, name, language, status, category, rejected_reason, quality_score, parameter_format, contract_hash, components, synced_at, saved_values";

/** Uma linha de `meta_templates` como o catálogo a lê. */
export interface LinhaDoCatalogo {
  id: string;
  waba_id: string;
  channel_session_id: string | null;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejected_reason: string | null;
  quality_score: string | null;
  parameter_format: string | null;
  contract_hash: string;
  components: unknown;
  synced_at: string;
  saved_values?: unknown;
}

/** Um espaço (`{{1}}`, cabeçalho de mídia, sufixo de URL…) que o envio precisa preencher. */
export interface EspacoDoModelo {
  key: string;
  expects: string;
  /** Rótulo humano do endereço: "corpo", "cabeçalho", "botão 1 (url)". */
  onde: string;
  /**
   * A chave de `template_values` para ESTE espaço, montada por `slotKey` — a
   * mesma função do montador de envio. É o que a tela usa como chave, para o
   * operador nunca ter de digitar `header:1` ou `button0:1`.
   */
  valueKey: string;
  /** Texto em volta do placeholder — o rótulo que ajuda a preencher. */
  contextBefore: string;
  contextAfter: string;
}

export interface BotaoDoModelo {
  /** `QUICK_REPLY`, `URL`, `PHONE_NUMBER`, `COPY_CODE`… como a plataforma declara. */
  tipo: string;
  texto: string;
}

export interface ModeloDoCatalogo {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  wabaId: string;
  /** `null` em linha da plataforma direta anterior à 0154 (sem conexão gravada). */
  channelSessionId: string | null;
  /** Aprovado — o único estado que a plataforma entrega. */
  utilizavel: boolean;
  conteudo: {
    header: { formato: string; texto: string | null } | null;
    body: string | null;
    footer: string | null;
    botoes: BotaoDoModelo[];
  };
  espacos: EspacoDoModelo[];
  /** Texto de cada componente que carrega variável, inteiro e uma vez só. */
  previews: Array<{ onde: string; text: string }>;
  /** A definição crua — de onde sai o texto que vai no corpo do envio. */
  components: unknown[];
  /** Links de mídia salvos para este modelo, filtrados pelo contrato de hoje. */
  savedValues: Record<string, string>;
}

/** Textos com placeholder, achatados (inclui os de dentro de card de carrossel). */
function textPreviews(components: unknown): Array<{ onde: string; text: string }> {
  const out: Array<{ onde: string; text: string }> = [];
  const visita = (lista: unknown, prefixo: string) => {
    if (!Array.isArray(lista)) return;
    for (const c of lista as Array<Record<string, unknown>>) {
      const tipo = String(c.type ?? "").toUpperCase();
      if (Array.isArray(c.cards)) {
        (c.cards as Array<Record<string, unknown>>).forEach((card, i) =>
          visita(card.components, `card ${i + 1} › `),
        );
        continue;
      }
      const texto = typeof c.text === "string" ? c.text : "";
      if (!texto.includes("{{")) continue;
      out.push({ onde: `${prefixo}${tipo === "HEADER" ? "cabeçalho" : "corpo"}`, text: texto });
    }
  };
  visita(components, "");
  return out;
}

/** O contrato derivado de uma linha — a MESMA derivação do envio. */
export function contratoDaLinha(linha: Pick<LinhaDoCatalogo, "name" | "language" | "parameter_format" | "components">): TemplateContract {
  return deriveTemplateContract({
    name: linha.name,
    language: linha.language,
    parameter_format: linha.parameter_format ?? undefined,
    components: linha.components as Parameters<typeof deriveTemplateContract>[0]["components"],
  });
}

/** Linha do espelho → modelo pronto para a tela. Puro: testável sem banco. */
export function modeloDaLinha(linha: LinhaDoCatalogo): ModeloDoCatalogo {
  const contrato = contratoDaLinha(linha);
  const conteudo = lerConteudo(linha.components);
  const salvos = mesclarValoresSalvos(contrato, (linha.saved_values ?? {}) as Record<string, unknown>, {});
  return {
    id: linha.id,
    name: linha.name,
    language: linha.language,
    status: linha.status,
    category: linha.category,
    // Normaliza na LEITURA também: o "NONE" da Meta pode ter sido gravado por
    // uma versão anterior ao conserto, e um clone atualizado ainda o carrega.
    rejectedReason: normalizeRejectedReason(linha.rejected_reason),
    qualityScore: linha.quality_score,
    parameterFormat: contrato.parameterFormat,
    contractHash: linha.contract_hash,
    syncedAt: linha.synced_at,
    wabaId: linha.waba_id,
    channelSessionId: linha.channel_session_id,
    utilizavel: isStatusSendable(linha.status),
    conteudo: {
      header: conteudo.header,
      body: conteudo.body,
      footer: conteudo.footer,
      botoes: conteudo.botoes,
    },
    espacos: contrato.slots.map((s) => ({
      key: s.key,
      expects: s.expects,
      onde: describeAddress(s.address),
      valueKey: slotKey(s.address, s.key),
      contextBefore: s.contextBefore,
      contextAfter: s.contextAfter,
    })),
    previews: textPreviews(linha.components),
    components: Array.isArray(linha.components) ? (linha.components as unknown[]) : [],
    savedValues: salvos.ok ? salvos.valores : {},
  };
}

/** Uma conexão que tem modelos no espelho — o que o seletor oferece. */
export interface ConexaoComModelos {
  id: string;
  rotulo: string;
  wabaId: string | null;
}

interface LinhaDeConexao {
  id: string;
  provider: string;
  display_name: string | null;
  phone_number: string | null;
  meta_waba_id: string | null;
}

/**
 * Só as fontes que moram no ESPELHO. O canal oficial e o parceiro
 * Graph-compatível sincronizam para `meta_templates`; o intermediado consulta a
 * API dele ao vivo e fica fora deste catálogo (ver `templates-fonte.ts`).
 */
function conexaoUsaOEspelho(provider: string): boolean {
  const fonte = fonteDeTemplates(provider);
  return fonte === "oficial" || fonte === "graph";
}

const ID_NUMERICO = /^\d+$/;

/**
 * O filtro de uma conexão, no formato `or` do PostgREST.
 *
 * Linha com `channel_session_id` é daquela conexão. Linha SEM ela é do canal
 * oficial anterior à 0154 (e do sync oficial, que grava por conta): pertence a
 * quem tem a mesma conta. O id da conta vem do BANCO (a sessão desta
 * organização) e ainda assim só entra no filtro se for número — é texto
 * interpolado numa expressão, e só dígitos não têm como alterá-la.
 */
export function escopoDaConexao(conexao: { id: string; meta_waba_id: string | null }): string {
  const daConexao = `channel_session_id.eq.${conexao.id}`;
  if (conexao.meta_waba_id && ID_NUMERICO.test(conexao.meta_waba_id)) {
    return `${daConexao},and(channel_session_id.is.null,waba_id.eq.${conexao.meta_waba_id})`;
  }
  return daConexao;
}

/**
 * As conexões ativas da organização que têm catálogo no espelho.
 *
 * `fonte` recorta a uma fonte só — a criação de modelo pelo canal oficial
 * oferece apenas as conexões oficiais, e usa ESTA lista em vez de uma segunda
 * consulta de conexões.
 */
export async function conexoesComModelos(
  db: SupabaseClient,
  organizationId: string,
  opcoes: { fonte?: "oficial" | "graph" } = {},
): Promise<ConexaoComModelos[]> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, provider, display_name, phone_number, meta_waba_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`catalogo_de_modelos: leitura das conexões falhou — ${error.message}`);
  return ((data ?? []) as LinhaDeConexao[])
    .filter((c) => conexaoUsaOEspelho(c.provider))
    .filter((c) => !opcoes.fonte || fonteDeTemplates(c.provider) === opcoes.fonte)
    .map((c) => ({
      id: c.id,
      rotulo: c.display_name?.trim() || c.phone_number?.trim() || "Número oficial",
      wabaId: c.meta_waba_id,
    }));
}

/**
 * A conexão, recortada pela organização e ativa, desde que o canal dela tenha
 * definições aprovadas (`fonteDeTemplates` não nulo) — o oficial, o
 * Graph-compatível e o intermediado espelham em `meta_templates`. Exportada
 * porque o pré-voo do envio (`conferir-definicao.ts`) precisa distinguir
 * "este número não tem catálogo" (WAHA: nada a conferir) de "o modelo não está
 * no catálogo deste número".
 */
export async function conexaoDaOrganizacao(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<LinhaDeConexao | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, provider, display_name, phone_number, meta_waba_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`catalogo_de_modelos: leitura da conexão falhou — ${error.message}`);
  const linha = (data as LinhaDeConexao | null) ?? null;
  return linha && fonteDeTemplates(linha.provider) !== null ? linha : null;
}

export interface FiltroDoCatalogo {
  /** Obrigatório. Vem da sessão autenticada, nunca do corpo da requisição. */
  organizationId: string;
  /** Recorta os modelos da conta desta conexão. Conexão de outra organização = lista vazia. */
  channelSessionId?: string | null;
  /** `true` = só os que a plataforma entrega (aprovados). */
  somenteUtilizaveis?: boolean;
}

/** Os modelos do catálogo, recortados por organização e, opcionalmente, por conexão. */
export async function listarModelos(db: SupabaseClient, filtro: FiltroDoCatalogo): Promise<ModeloDoCatalogo[]> {
  let q = db
    .from("meta_templates")
    .select(COLUNAS)
    .eq("organization_id", filtro.organizationId);

  if (filtro.channelSessionId) {
    const conexao = await conexaoDaOrganizacao(db, filtro.organizationId, filtro.channelSessionId);
    // Conexão que não é desta organização (ou não tem catálogo) não devolve
    // nada — nunca "a organização inteira" por falta de recorte.
    if (!conexao) return [];
    q = q.or(escopoDaConexao(conexao));
  }

  const { data, error } = await q.order("status").order("name").order("language");
  if (error) throw new Error(`catalogo_de_modelos: leitura do espelho falhou — ${error.message}`);
  const modelos = ((data ?? []) as LinhaDoCatalogo[]).map(modeloDaLinha);
  return filtro.somenteUtilizaveis ? modelos.filter((m) => m.utilizavel) : modelos;
}

/** O que uma configuração guarda para apontar para um modelo. */
export interface ReferenciaDeModelo {
  /**
   * Sem conexão e sem id, o par (nome, idioma) pode existir em DUAS contas da
   * organização. `true` = nesse caso não escolhe nenhuma (devolve `null`) — a
   * regra que o pré-voo do envio sempre teve para a base sem número. Ausente, o
   * mais recente sincronizado responde (o que a tela usa para mostrar).
   */
  ambiguoNaoResolve?: boolean;
  templateId?: string | null;
  name?: string | null;
  language?: string | null;
  channelSessionId?: string | null;
}

/**
 * Resolve a referência de uma configuração para o modelo ATUAL do espelho.
 *
 * Pelo `templateId` quando existe (o caminho novo). Configuração anterior a ele
 * guarda só nome e idioma: resolve por esse par, recortado pela conexão quando
 * houver — é a compatibilidade com o fluxo antigo. `null` = não localizado, e
 * quem chama decide o que dizer; nunca lança por referência inexistente.
 */
export async function resolverModelo(
  db: SupabaseClient,
  organizationId: string,
  ref: ReferenciaDeModelo,
): Promise<ModeloDoCatalogo | null> {
  if (ref.templateId) {
    let q = db
      .from("meta_templates")
      .select(COLUNAS)
      .eq("organization_id", organizationId)
      .eq("id", ref.templateId);
    // A configuração fixa a conexão que ENVIA (o modelo é aprovado por conta).
    // Modelo de uma conta com a conexão de outra, conexão arquivada ou de outra
    // organização: não resolve — e a ativação diz isso, em vez de o envio
    // descobrir na hora com o contato dentro.
    if (ref.channelSessionId) {
      const conexao = await conexaoDaOrganizacao(db, organizationId, ref.channelSessionId);
      if (!conexao) return null;
      q = q.or(escopoDaConexao(conexao));
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`catalogo_de_modelos: leitura do modelo falhou — ${error.message}`);
    return data ? modeloDaLinha(data as LinhaDoCatalogo) : null;
  }

  const name = ref.name?.trim();
  const language = ref.language?.trim();
  if (!name || !language) return null;

  let q = db
    .from("meta_templates")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("name", name)
    .eq("language", language);
  if (ref.channelSessionId) {
    const conexao = await conexaoDaOrganizacao(db, organizationId, ref.channelSessionId);
    if (!conexao) return null;
    q = q.or(escopoDaConexao(conexao));
  }
  const { data, error } = await q.order("synced_at", { ascending: false }).limit(2);
  if (error) throw new Error(`catalogo_de_modelos: leitura do modelo falhou — ${error.message}`);
  const linhas = (data ?? []) as LinhaDoCatalogo[];
  if (ref.ambiguoNaoResolve && !ref.channelSessionId && linhas.length > 1) return null;
  const linha = linhas[0];
  return linha ? modeloDaLinha(linha) : null;
}
