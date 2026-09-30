/**
 * O NÓ DE MENSAGEM EM BLOCOS — a estrutura única que o construtor de Automações
 * e o de Disparos (modo fluxo) editam, e que o motor executa.
 *
 * ─── O que um nó contém ─────────────────────────────────────────────────────
 *
 * Uma sequência ORDENADA de blocos:
 *
 *   texto   uma mensagem; pode levar botões
 *   imagem  uma imagem (com legenda opcional)
 *   atraso  espera entre os blocos do MESMO nó ("Aguardando 3 segundos…")
 *
 * O usuário vê um nó só; o motor transforma em mensagem 1 → espera → mensagem 2
 * → … A espera é DURÁVEL: vira `waiting_for = 'delay'` com o cursor do bloco
 * gravado na execução (migration 0502), nunca `setTimeout` no processo.
 *
 * ─── Botão ≠ Próximo passo ──────────────────────────────────────────────────
 *
 * O botão é CONTEÚDO da mensagem, e faz UMA de duas coisas:
 *
 *   - `acao: "url"`   abre o site informado. Não é saída do fluxo.
 *   - `acao: "fluxo"` é uma saída do nó (`button:<id>`): o clique conduz à
 *                     etapa ligada a ele.
 *
 * O "Próximo passo" é a saída PADRÃO do nó (aresta sem `source_handle`), e
 * existe em todo nó de mensagem — com ou sem botão. O fluxo segue por ela assim
 * que o último bloco sai, independentemente do clique. Um clique que chegue
 * DEPOIS desvia a mesma execução para a saída do botão (ver o motor).
 *
 * Compatibilidade: um nó sem nenhuma aresta de Próximo passo e com botão de
 * fluxo continua ESPERANDO o clique, como sempre esperou.
 *
 * ─── O formato antigo ───────────────────────────────────────────────────────
 *
 * Nó gravado antes dos blocos tem `body` + `buttons: [{label}]`, e as arestas
 * dos botões são `button:<índice>`. Ele é LIDO como um bloco de texto com esses
 * botões (`blocosDaMensagem`), e as saídas continuam `button:<índice>` — nenhum
 * fluxo é reescrito, e nenhuma aresta perde o destino. O formato novo só é
 * gravado quando alguém edita o nó.
 */
import { renderFlowTemplate } from "@/lib/flows/template";
import type { MessageNodeConfig } from "@/lib/flows/types";

export type AcaoDoBotao = "fluxo" | "url";

export interface BotaoDoBloco {
  /** Estável: é o que a aresta guarda (`button:<id>`), e reordenar não a quebra. */
  id: string;
  rotulo: string;
  acao: AcaoDoBotao;
  /** Só para `acao: "url"`. */
  url?: string;
}

export interface BlocoDeTexto {
  id: string;
  tipo: "texto";
  texto: string;
  botoes?: BotaoDoBloco[];
}

export interface BlocoDeImagem {
  id: string;
  tipo: "imagem";
  /** Caminho em `whatsapp-media` (`<org>/flows/<fluxo>/…`). */
  media_storage_path?: string;
  media_mime?: string;
  legenda?: string;
}

export interface BlocoDeAtraso {
  id: string;
  tipo: "atraso";
  segundos: number;
}

export type BlocoDaMensagem = BlocoDeTexto | BlocoDeImagem | BlocoDeAtraso;

/** Limites do construtor — a mesma régua na tela e na validação. */
export const LIMITE_DE_BLOCOS = 20;
export const LIMITE_DE_BOTOES_POR_TEXTO = 3;
export const ATRASO_MIN_SEGUNDOS = 1;
export const ATRASO_MAX_SEGUNDOS = 24 * 60 * 60;
export const LIMITE_ROTULO_DO_BOTAO = 20;

/** Quanto tempo um botão de fluxo segue clicável depois do Próximo passo. */
export const BOTAO_CLICAVEL_POR_MS = 72 * 60 * 60 * 1000;

/**
 * Os blocos do nó. Nó novo: `config.blocks`. Nó antigo: um bloco de texto com
 * o `body` e os `buttons` de sempre, com ids que reproduzem as saídas antigas.
 */
export function blocosDaMensagem(config: MessageNodeConfig): BlocoDaMensagem[] {
  if (Array.isArray(config.blocks) && config.blocks.length > 0) return config.blocks;
  // O id do botão antigo é o ÍNDICE: convertido para blocos, a saída continua
  // `button:<i>` — a mesma que as arestas já guardam.
  const botoes = (config.buttons ?? []).map((b, i) => ({
    id: String(i),
    rotulo: b.label,
    acao: "fluxo" as const,
  }));
  if (!config.body?.trim() && botoes.length === 0) return [];
  return [{ id: "legado", tipo: "texto", texto: config.body ?? "", ...(botoes.length ? { botoes } : {}) }];
}

/** O nó usa o formato novo? (Decide o nome das saídas.) */
export function usaBlocos(config: MessageNodeConfig): boolean {
  return Array.isArray(config.blocks) && config.blocks.length > 0;
}

export interface SaidaDeBotao {
  /** O `source_handle` da aresta. */
  handle: string;
  rotulo: string;
}

/**
 * As saídas de BOTÃO do nó, na ordem em que aparecem — e só as de fluxo: o
 * botão de URL leva ao site, não a uma etapa.
 *
 *   - modelo aprovado (fora da janela): as respostas rápidas do modelo, `button:<i>`;
 *   - formato antigo: `button:<i>`;
 *   - blocos: `button:<id do botão>`.
 */
export function saidasDeBotao(config: MessageNodeConfig): SaidaDeBotao[] {
  if (config.window_mode === "outside_24h" || !usaBlocos(config)) {
    return (config.buttons ?? []).map((b, i) => ({ handle: `button:${i}`, rotulo: b.label }));
  }
  const out: SaidaDeBotao[] = [];
  for (const bloco of config.blocks ?? []) {
    if (bloco.tipo !== "texto") continue;
    for (const b of bloco.botoes ?? []) {
      if (b.acao === "fluxo") out.push({ handle: `button:${b.id}`, rotulo: b.rotulo });
    }
  }
  return out;
}

/**
 * Casa a resposta do contato com uma saída de botão, da tentativa mais
 * confiável para a mais frouxa (a mesma ordem de sempre):
 *
 *   1. o id canônico da saída (`button:…`), como a aresta o nomeia — o que um
 *      botão nativo mandaria;
 *   2. o número que a lista mostrou ("1" → primeira saída);
 *   3. o rótulo exato, sem caixa;
 *   4. o rótulo contido na frase.
 */
export function casarSaidaDeBotao(saidas: SaidaDeBotao[], resposta: string): string | null {
  if (!saidas.length) return null;
  const limpo = resposta.trim();
  if (limpo.startsWith("button:")) return saidas.find((s) => s.handle === limpo)?.handle ?? null;
  const numero = Number(limpo);
  if (Number.isInteger(numero) && numero >= 1 && numero <= saidas.length) return saidas[numero - 1]!.handle;
  const minusculo = limpo.toLowerCase();
  const exato = saidas.find((s) => s.rotulo.toLowerCase() === minusculo);
  if (exato) return exato.handle;
  const contido = saidas.find((s) => s.rotulo && minusculo.includes(s.rotulo.toLowerCase()));
  return contido?.handle ?? null;
}

/**
 * O texto que SAI para um bloco de texto.
 *
 * O canal ainda não manda botão nativo (ver o cabeçalho de `nodes/message.ts`):
 * o botão de fluxo sai como opção NUMERADA — a numeração é contínua no nó
 * inteiro, para "2" casar com a segunda saída mesmo em outro bloco — e o botão
 * de URL sai como "Rótulo: endereço", que o WhatsApp torna clicável.
 */
export function textoDoBloco(
  bloco: BlocoDeTexto,
  contexto: Record<string, unknown>,
  numeroInicial: number,
): { texto: string; proximoNumero: number } {
  const corpo = bloco.texto ? renderFlowTemplate(bloco.texto, contexto) : "";
  const linhas: string[] = [];
  let n = numeroInicial;
  for (const b of bloco.botoes ?? []) {
    if (!b.rotulo.trim()) continue;
    if (b.acao === "url") {
      if (b.url?.trim()) linhas.push(`${b.rotulo}: ${b.url.trim()}`);
    } else {
      linhas.push(`${n}. ${b.rotulo}`);
      n += 1;
    }
  }
  return { texto: [corpo, ...linhas].filter(Boolean).join("\n"), proximoNumero: n };
}

/** O número da PRIMEIRA opção de fluxo de cada bloco — para retomar no meio do nó. */
export function numeroInicialDoBloco(blocos: BlocoDaMensagem[], indice: number): number {
  let n = 1;
  for (let i = 0; i < indice && i < blocos.length; i++) {
    const b = blocos[i]!;
    if (b.tipo === "texto") n += (b.botoes ?? []).filter((x) => x.acao === "fluxo" && x.rotulo.trim()).length;
  }
  return n;
}

/** URL que o botão pode abrir: http(s) com host. */
export function urlDeBotaoValida(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** Os problemas dos blocos de um nó — o que impede ATIVAR o fluxo. Pura. */
export function problemasDosBlocos(config: MessageNodeConfig, nome: string): string[] {
  const blocos = blocosDaMensagem(config);
  const problemas: string[] = [];
  if (blocos.filter((b) => b.tipo !== "atraso").length === 0) {
    return [`Em ${nome}, adicione um texto ou uma imagem para enviar.`];
  }
  if (blocos.length > LIMITE_DE_BLOCOS) problemas.push(`Em ${nome}, use no máximo ${LIMITE_DE_BLOCOS} blocos.`);
  blocos.forEach((b, i) => {
    const onde = `${nome}, bloco ${i + 1}`;
    if (b.tipo === "texto") {
      const botoes = b.botoes ?? [];
      if (!b.texto.trim() && botoes.length === 0) problemas.push(`Em ${onde}, escreva o texto.`);
      if (botoes.length > 0 && !b.texto.trim()) problemas.push(`Em ${onde}, o botão precisa de um texto acima dele.`);
      if (botoes.length > LIMITE_DE_BOTOES_POR_TEXTO) {
        problemas.push(`Em ${onde}, use no máximo ${LIMITE_DE_BOTOES_POR_TEXTO} botões.`);
      }
      for (const bt of botoes) {
        if (!bt.rotulo.trim()) problemas.push(`Em ${onde}, dê um título a cada botão.`);
        if (bt.acao === "url" && !urlDeBotaoValida(bt.url)) {
          problemas.push(`Em ${onde}, o botão "${bt.rotulo || "sem título"}" precisa de um endereço válido (https://…).`);
        }
      }
    } else if (b.tipo === "imagem") {
      if (!b.media_storage_path) problemas.push(`Em ${onde}, escolha a imagem.`);
    } else {
      const s = Number(b.segundos);
      if (!Number.isFinite(s) || s < ATRASO_MIN_SEGUNDOS || s > ATRASO_MAX_SEGUNDOS) {
        problemas.push(`Em ${onde}, o atraso vai de 1 segundo a 24 horas.`);
      }
    }
  });
  return problemas;
}

/** Resumo de uma linha do nó, para o card do canvas. */
export function resumoDosBlocos(config: MessageNodeConfig): string {
  const blocos = blocosDaMensagem(config);
  const primeiro = blocos.find((b) => b.tipo === "texto" && b.texto.trim()) as BlocoDeTexto | undefined;
  const outros = blocos.length - (primeiro ? 1 : 0);
  const base = primeiro ? primeiro.texto.trim().slice(0, 60) : "";
  return outros > 0 && usaBlocos(config) ? `${base}${base ? " " : ""}(+${outros})` : base;
}
