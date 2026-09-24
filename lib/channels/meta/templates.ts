/**
 * Gestão das definições aprovadas do canal OFICIAL — por ora, só CRIAR.
 *
 * Mesmo contrato dos parceiros (`ChannelTemplateOps`, ver
 * `graph-parceiro/templates.ts`): o adapter é burro, traduz o rascunho para a
 * Graph API e devolve o que a plataforma disse. Ele NÃO espelha no banco — quem
 * grava a linha de `meta_templates` é `criar-modelo.ts`, que é quem sabe da
 * conexão e do catálogo.
 *
 * ─── O que esta integração suporta, e o que ela recusa ANTES da Meta ─────────
 *
 * Cabeçalho de TEXTO, corpo com `{{n}}`, rodapé e até três botões (resposta
 * rápida, link, telefone) — o que o formulário monta (`montarComponents`).
 * Cabeçalho de MÍDIA fica de fora: a Meta só aceita, na criação, o arquivo
 * enviado pelo upload dela (`header_handle` de uma sessão de upload), e esta
 * integração ainda não faz esse upload. Mandar um link comum ali é recusa certa
 * — então a recusa sai aqui, com a frase que diz por quê, em vez de horas
 * depois da revisão.
 *
 * ─── O que ainda NÃO existe ─────────────────────────────────────────────────
 *
 * Listar é a sincronização (`template-sync.ts`), que já espelha a conta inteira;
 * editar e apagar são a próxima etapa. Os três métodos lançam com o motivo em vez
 * de fingir que funcionam.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_META } from "../capabilities";
import { contarVariaveis, LIMITE_BOTOES, LIMITE_CORPO, LIMITE_RODAPE } from "../template-conteudo";
import type { ChannelTemplate, ChannelTemplateDraft, ChannelTemplateOps } from "../types";

import { resolveMetaCreds } from "./credentials";

/** Limites de texto da Meta que o formulário não conta. */
const LIMITE_CABECALHO = 60;
const LIMITE_TEXTO_DO_BOTAO = 25;
/** Quanto esperar a Graph antes de desistir. Criar é uma chamada só, e rápida. */
const TEMPO_LIMITE_MS = 20_000;

const NOME_VALIDO = /^[a-z0-9_]{1,512}$/;
const IDIOMA_VALIDO = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;
const CATEGORIAS = new Set(["AUTHENTICATION", "MARKETING", "UTILITY"]);
const TIPOS_DE_BOTAO = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
const ID_NUMERICO = /^\d+$/;

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const texto = (v: unknown): string => (typeof v === "string" ? v : "");

/** Os índices de `{{n}}` usados — para recusar numeração com buraco. */
function indices(t: string): number[] {
  return [...new Set([...t.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

function numeracaoContinua(t: string): boolean {
  return indices(t).every((n, i) => n === i + 1);
}

/**
 * Confere o rascunho com as regras que a Meta aplica e que se sabe de antemão.
 * `null` = pode seguir. A frase é o que o operador lê.
 */
export function validarRascunhoOficial(draft: ChannelTemplateDraft): string | null {
  if (!NOME_VALIDO.test(draft.name ?? "")) {
    return "O nome aceita só letras minúsculas, números e _ (ex.: confirmacao_de_pedido).";
  }
  if (!IDIOMA_VALIDO.test(draft.language ?? "")) return "Idioma inválido (ex.: pt_BR).";
  if (!CATEGORIAS.has(draft.category)) return "Categoria inválida.";
  if (draft.parameterFormat && draft.parameterFormat !== "POSITIONAL") {
    return "Esta integração cria modelos só com valores numerados ({{1}}, {{2}}…).";
  }
  if (!Array.isArray(draft.components) || draft.components.length === 0) {
    return "O modelo precisa de conteúdo.";
  }

  const vistos = new Set<string>();
  let temCorpo = false;
  for (const bruto of draft.components) {
    const c = obj(bruto);
    const tipo = texto(c?.type).toUpperCase();
    if (!c || !["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(tipo)) {
      return "Componente desconhecido no modelo.";
    }
    if (vistos.has(tipo)) return `O modelo tem mais de um componente ${tipo}.`;
    vistos.add(tipo);

    if (tipo === "HEADER") {
      if (texto(c.format).toUpperCase() !== "TEXT") {
        return "Cabeçalho com imagem, vídeo ou documento ainda não é suportado na criação pelo canal oficial: a Meta exige o arquivo enviado pelo upload dela. Use um cabeçalho de texto, ou crie esse modelo no Gerenciador do WhatsApp e sincronize.";
      }
      const t = texto(c.text).trim();
      if (!t) return "O cabeçalho de texto está vazio.";
      if (t.length > LIMITE_CABECALHO) return `O cabeçalho passa de ${LIMITE_CABECALHO} caracteres.`;
      const n = contarVariaveis(t);
      if (n > 1) return "O cabeçalho aceita no máximo um valor ({{1}}).";
      if (!numeracaoContinua(t)) return "O cabeçalho só pode usar {{1}}.";
      const exemplos = obj(c.example)?.header_text;
      if (n > 0 && (!Array.isArray(exemplos) || exemplos.length !== n || !exemplos.every((e) => texto(e).trim()))) {
        return "Falta o exemplo do valor do cabeçalho.";
      }
    }

    if (tipo === "BODY") {
      temCorpo = true;
      const t = texto(c.text);
      if (!t.trim()) return "O texto da mensagem está vazio.";
      if (t.length > LIMITE_CORPO) return `O texto passa de ${LIMITE_CORPO} caracteres.`;
      if (!numeracaoContinua(t)) return "Os valores precisam ser numerados sem pular: {{1}}, {{2}}, {{3}}…";
      const n = contarVariaveis(t);
      if (n > 0) {
        const amostras = (obj(c.example)?.body_text as unknown[] | undefined)?.[0];
        if (!Array.isArray(amostras) || amostras.length !== n || !amostras.every((e) => texto(e).trim())) {
          return "A revisão exige um exemplo de cada valor do texto.";
        }
      }
    }

    if (tipo === "FOOTER") {
      const t = texto(c.text);
      if (!t.trim()) return "O rodapé está vazio.";
      if (t.length > LIMITE_RODAPE) return `O rodapé passa de ${LIMITE_RODAPE} caracteres.`;
      if (contarVariaveis(t) > 0) return "O rodapé não aceita valores ({{n}}).";
    }

    if (tipo === "BUTTONS") {
      const botoes = Array.isArray(c.buttons) ? c.buttons : [];
      if (botoes.length === 0) return "O componente de botões está vazio.";
      if (botoes.length > LIMITE_BOTOES) return `No máximo ${LIMITE_BOTOES} botões.`;
      for (const b of botoes) {
        const botao = obj(b);
        const tipoDoBotao = texto(botao?.type).toUpperCase();
        if (!botao || !TIPOS_DE_BOTAO.has(tipoDoBotao)) return "Tipo de botão não suportado.";
        const rotulo = texto(botao.text).trim();
        if (!rotulo) return "Todo botão precisa de texto.";
        if (rotulo.length > LIMITE_TEXTO_DO_BOTAO) {
          return `O texto do botão passa de ${LIMITE_TEXTO_DO_BOTAO} caracteres.`;
        }
        if (tipoDoBotao === "URL" && !/^https:\/\/[^\s/]+/i.test(texto(botao.url).trim())) {
          return "O botão de link precisa de um endereço https://.";
        }
        if (tipoDoBotao === "PHONE_NUMBER" && !/^\+?\d{8,15}$/.test(texto(botao.phone_number).replace(/[\s()-]/g, ""))) {
          return "O botão de telefone precisa de um número com DDI (ex.: +5531999998888).";
        }
      }
    }
  }
  if (!temCorpo) return "O modelo precisa de um texto de mensagem.";
  return null;
}

/** O que a Graph devolve — na criação, `{ id, status, category }`. */
interface RespostaDaGraph {
  id?: unknown;
  status?: unknown;
  category?: unknown;
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    error_data?: { details?: string };
  };
}

/**
 * Traduz a recusa da Graph num desfecho com NOME — credencial, conta ou revisão —,
 * preservando a frase da Meta (é ela que diz o que corrigir). Nunca carrega o
 * token: ele vai no header, e a Meta não o ecoa.
 */
export function erroDaCriacao(status: number, json: RespostaDaGraph | null): Error {
  const e = json?.error;
  const code = e?.code ?? null;
  const sub = e?.error_subcode ?? null;
  const frase =
    e?.error_user_msg ?? e?.error_data?.details ?? e?.message ?? `a Graph respondeu ${status}`;
  const onde = `(${[code, sub].filter((v) => v !== null).join("/") || status}) ${frase}`;

  // 190 = token inválido ou vencido; 401 sem corpo, idem.
  if (code === 190 || status === 401) return new Error(`meta_template_credencial: ${onde}`);
  // 100/33 = o objeto (a conta) não existe ou este token não o alcança;
  // 200 e 10 = sem permissão na conta.
  if ((code === 100 && sub === 33) || code === 200 || code === 10) {
    return new Error(`meta_template_waba: ${onde}`);
  }
  return new Error(`meta_template_rejeitado: ${onde}`);
}

/** A conexão oficial ATIVA desta organização que atende este número. */
async function contaDoNumero(organizationId: string, phoneNumberId: string) {
  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_waba_id")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) throw new Error(`meta_template_conexao: leitura da conexão falhou — ${error.message ?? ""}`.trim());
  const linha = data as { id: string; meta_waba_id: string | null } | null;
  if (!linha) throw new Error("meta_template_conexao: esta conexão oficial não é desta organização ou foi excluída.");
  if (!linha.meta_waba_id || !ID_NUMERICO.test(linha.meta_waba_id)) {
    throw new Error("meta_template_sem_waba: a conexão não tem conta do WhatsApp Business (WABA) gravada.");
  }
  return { wabaId: linha.meta_waba_id, admin };
}

function indisponivel(acao: string): never {
  throw new Error(`meta_template_indisponivel: ${acao} ainda não é feito pelo CRM no canal oficial.`);
}

export const metaCloudTemplateOps: ChannelTemplateOps = {
  /**
   * Cria a definição na conta DESTA conexão e devolve o que a Meta respondeu —
   * o status é o dela (na criação, PENDING), nunca presumido aprovado.
   */
  async create({ organizationId, sessionRef, draft }): Promise<ChannelTemplate> {
    const motivo = validarRascunhoOficial(draft);
    if (motivo) throw new Error(`meta_template_validacao: ${motivo}`);

    // Conta e credencial saem do PAR (organização, número): o número de outra
    // organização não casa linha nenhuma, e a credencial de outra organização
    // nunca é lida (`resolveMetaCreds` filtra pela organização).
    const { wabaId, admin } = await contaDoNumero(organizationId, sessionRef);
    const creds = await resolveMetaCreds(admin, { organizationId, phoneNumberId: sessionRef });
    if (!creds) {
      throw new Error("meta_not_configured: sem credencial para esta conexão (nem na sessão, nem no ambiente).");
    }

    const url = `https://graph.facebook.com/${creds.graphVersion}/${encodeURIComponent(wabaId)}/message_templates`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          language: draft.language,
          category: draft.category,
          components: draft.components,
          ...(draft.parameterFormat ? { parameter_format: draft.parameterFormat } : {}),
        }),
        signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      });
    } catch (err) {
      // Sem resposta, não se sabe se a Meta criou. O espelho não recebe nada; a
      // sincronização mostra depois o que existe de fato.
      const causa = err instanceof Error ? err.message : String(err);
      throw new Error(`meta_template_rede: a Meta não respondeu (${causa}). Sincronize antes de tentar de novo.`);
    }

    const json = (await res.json().catch(() => null)) as RespostaDaGraph | null;
    if (!res.ok || json?.error) throw erroDaCriacao(res.status, json);

    const id = typeof json?.id === "string" || typeof json?.id === "number" ? String(json.id) : "";
    if (!id) throw new Error("meta_template_rejeitado: a Meta aceitou o pedido mas não devolveu o id do modelo.");

    return {
      name: draft.name,
      language: draft.language,
      // O estado é o que a Meta disse. Sem ele, PENDING — o estado de todo modelo
      // recém-criado. Nunca APPROVED por conta própria.
      status: typeof json?.status === "string" && json.status ? json.status : "PENDING",
      category: typeof json?.category === "string" && json.category ? json.category : draft.category,
      // A criação não devolve os componentes: os que foram enviados são os que a
      // Meta revisa.
      components: draft.components,
      rejectedReason: null,
      parameterFormat: draft.parameterFormat ?? "POSITIONAL",
      providerTemplateId: id,
    };
  },

  list: async () => indisponivel("Listar (use a sincronização)"),
  update: async () => indisponivel("Editar"),
  remove: async () => indisponivel("Apagar"),
};
