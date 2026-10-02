/**
 * AS VARIÁVEIS de um modelo aprovado — uma régua só para o formulário, o
 * validador, a criação, a sincronização e o envio.
 *
 * ─── O defeito que isto conserta ──────────────────────────────────────────
 *
 * O modelo `var1_teste` foi criado com `{{var1}}` e `{{var2}}`. Cada peça do
 * produto lia variável com uma régua diferente:
 *
 *   - o formulário e o validador só enxergavam `{{n}}` numérico — para eles o
 *     texto tinha ZERO variáveis: nenhum campo de exemplo, nenhum
 *     `parameter_format`, e a validação passava;
 *   - a criação gravava `parameter_format = POSITIONAL` por PRESUNÇÃO
 *     (`draft.parameterFormat ?? "POSITIONAL"`), sem perguntar à Meta;
 *   - a Meta classificou o modelo como NAMED;
 *   - o envio leu POSITIONAL do banco e mandou parâmetros sem `parameter_name`
 *     — e a Meta respondeu 132000 ("expected number of params (0)").
 *
 * Aqui mora a régua única. O formato de um modelo é DERIVADO dos próprios
 * tokens: `{{1}}` é posicional, `{{primeiro_nome}}` é nomeado, e misturar os
 * dois é recusado — a Meta aceita um formato por modelo.
 *
 * ─── O que é um nome válido ───────────────────────────────────────────────
 *
 * A Meta aceita, em parâmetro nomeado, letras minúsculas, números e `_`. Aqui o
 * nome começa por letra (`var1`, `primeiro_nome`); só dígitos é posicional.
 * `{{VAR1}}` e `{{contact.name}}` são RECUSADOS com a frase que diz como
 * escrever — antes, eram texto mudo que ninguém via.
 */

export type FormatoDeParametro = "POSITIONAL" | "NAMED";

export interface VariavelDoModelo {
  /** `"1"` (posicional) ou `"primeiro_nome"` (nomeado). */
  nome: string;
  posicional: boolean;
}

export interface LeituraDeVariaveis {
  /** Distintas, na ordem da PRIMEIRA aparição no texto. */
  variaveis: VariavelDoModelo[];
  /** Os marcadores `{{…}}` que não são nem número nem nome válido. */
  invalidas: string[];
}

/** Qualquer `{{…}}` — o que é válido se decide depois, para poder recusar com motivo. */
const MARCADOR = /\{\{\s*([^{}]*?)\s*\}\}/g;
const POSICIONAL = /^\d+$/;
const NOMEADA = /^[a-z][a-z0-9_]*$/;

export function lerVariaveis(texto: string | null | undefined): LeituraDeVariaveis {
  const vistas = new Set<string>();
  const variaveis: VariavelDoModelo[] = [];
  const invalidas: string[] = [];
  for (const m of (texto ?? "").matchAll(MARCADOR)) {
    const nome = (m[1] ?? "").trim();
    if (POSICIONAL.test(nome) || NOMEADA.test(nome)) {
      if (vistas.has(nome)) continue;
      vistas.add(nome);
      variaveis.push({ nome, posicional: POSICIONAL.test(nome) });
    } else if (!invalidas.includes(m[0])) {
      invalidas.push(m[0]);
    }
  }
  return { variaveis, invalidas };
}

/**
 * O formato que um conjunto de textos IMPÕE. `null` = nenhuma variável (o
 * modelo não precisa declarar formato); `"MISTO"` = os dois, o que a Meta
 * recusa.
 */
export function formatoDosTextos(textos: Array<string | null | undefined>): FormatoDeParametro | "MISTO" | null {
  let pos = false;
  let nom = false;
  for (const t of textos) {
    for (const v of lerVariaveis(t).variaveis) {
      if (v.posicional) pos = true;
      else nom = true;
    }
  }
  if (pos && nom) return "MISTO";
  if (nom) return "NAMED";
  if (pos) return "POSITIONAL";
  return null;
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;

/** Os textos que carregam variável: cabeçalho de texto, corpo e sufixo de botão URL. */
export function textosComVariavel(components: unknown): string[] {
  const out: string[] = [];
  for (const bruto of Array.isArray(components) ? components : []) {
    const c = obj(bruto);
    if (!c) continue;
    const tipo = String(c.type ?? "").toUpperCase();
    if ((tipo === "HEADER" || tipo === "BODY") && typeof c.text === "string") out.push(c.text);
    if (tipo === "BUTTONS" && Array.isArray(c.buttons)) {
      for (const b of c.buttons) {
        const url = obj(b)?.url;
        if (typeof url === "string") out.push(url);
      }
    }
  }
  return out;
}

/** O formato que os `components` de um modelo impõem. */
export function formatoDosComponentes(components: unknown): FormatoDeParametro | "MISTO" | null {
  return formatoDosTextos(textosComVariavel(components));
}

/**
 * O formato EFETIVO de um modelo, quando o declarado pode estar errado.
 *
 * O declarado pela Meta é a autoridade — MENOS num caso que não tem leitura
 * possível: declarado POSITIONAL com marcador NOMEADO. Um modelo posicional
 * não tem como conter `{{var1}}` como parâmetro, então a declaração é a que
 * está errada (foi a presunção gravada na criação). Nomeado com chave numérica
 * existe e fica como declarado.
 */
export function formatoEfetivo(declarado: string | null | undefined, components: unknown): FormatoDeParametro {
  if (declarado === "NAMED") return "NAMED";
  return formatoDosComponentes(components) === "NAMED" ? "NAMED" : "POSITIONAL";
}
