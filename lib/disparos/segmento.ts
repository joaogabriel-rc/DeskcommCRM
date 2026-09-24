/**
 * A SEGMENTAÇÃO — quem entra num disparo.
 *
 * Traduz o `segment` jsonb (lib/schemas/disparos.ts) para uma query sobre
 * `contacts`. Uma função só, usada em três lugares que PRECISAM concordar:
 * a prévia de público na tela, a materialização dos destinatários quando o
 * disparo é agendado, e qualquer relatório futuro. Fossem três queries, a
 * prévia diria 320 e sairiam 287 — e ninguém descobriria qual das duas está
 * certa.
 *
 * ── As exclusões que não são filtro do usuário ───────────────────────────────
 *
 * Contato bloqueado (opt-out / STOP), anonimizado (LGPD) e mesclado nunca
 * entram, independentemente do que o operador escolheu. Não é uma opção da
 * tela: mandar campanha para quem pediu para sair é o que derruba o número.
 * E sem telefone não há para onde mandar.
 *
 * ── A expressão, e onde ela mora ─────────────────────────────────────────────
 *
 * `filtrosDoSegmento` é PURA: segmento → lista de filtros do PostgREST. É ela
 * que a contagem, a listagem (materialização) e a tela (`expressaoDoSegmento`)
 * leem — a tela mostra a mesma estrutura que vira query, nunca uma descrição
 * paralela. `aplicar` só pendura a lista no builder.
 *
 * ── O que é texto do operador, e como ele entra ─────────────────────────────
 *
 * Etiqueta e valor de campo são texto que alguém digitou (ou que veio de uma
 * importação), e texto assim NÃO entra cru numa expressão:
 *
 *   - a CHAVE do campo vira nome de coluna — por isso só passa se casar com a
 *     regra do registro de campos (`CHAVE_DE_CAMPO`, validada no schema e de
 *     novo aqui);
 *   - dentro de `or(...)` e de literal de array, todo valor vai entre aspas
 *     duplas com `\` e `"` escapados — vírgula, ponto, parêntese e dois-pontos
 *     deixam de ser sintaxe (a regra do PostgREST para valores reservados);
 *   - "contém" é regex LITERAL (`imatch`, ver `regexDeContem`), não LIKE: o
 *     PostgREST troca todo `*` de um LIKE por `%` sem forma de escapar. `*`,
 *     `%`, `_`, `.`, parêntese e `\` são texto — "50%" procura "50%".
 *
 * A organização é SEMPRE o primeiro filtro, fora de qualquer `or()`: nenhum
 * grupo consegue alargá-la.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHAVE_DE_CAMPO } from "@/lib/schemas/contact-fields";
import {
  NEGACAO_DO_OPERADOR,
  SEGMENTO_VAZIO,
  type CriterioDeCampo,
  type Segmento,
} from "@/lib/schemas/disparos";

/** As colunas que o worker precisa de cada destinatário. Interno: só
 * `listarPublico` a usa, e exportá-la convidaria uma segunda lista a existir. */
const COLUNAS_DO_PUBLICO = "id, name, display_name, phone_number, tags, custom_fields";

/**
 * A FACE do builder do PostgREST que esta função usa.
 *
 * Existe por um motivo mecânico, não estético: encadear `.eq().is().not().or()`
 * sobre o tipo genérico do `supabase-js` estoura o limite de profundidade do
 * TypeScript (`TS2589: type instantiation is excessively deep`) — cada filtro
 * acrescenta uma camada ao tipo do builder, e a segmentação encadeia dez. A
 * interface fecha o tipo num ponto fixo: os métodos devolvem `Filtros`, não um
 * tipo novo a cada chamada.
 */
interface Filtros {
  eq(coluna: string, valor: unknown): Filtros;
  is(coluna: string, valor: null): Filtros;
  not(coluna: string, operador: string, valor: unknown): Filtros;
  or(filtro: string): Filtros;
  filter(coluna: string, operador: string, valor: unknown): Filtros;
  contains(coluna: string, valor: unknown): Filtros;
  overlaps(coluna: string, valor: unknown): Filtros;
}

/** Um filtro do PostgREST, como dado — o que a query recebe, na ordem. */
export type FiltroDoSegmento =
  | { metodo: "eq"; coluna: string; valor: string | boolean }
  | { metodo: "is"; coluna: string }
  | { metodo: "not"; coluna: string; operador: string; valor: string | null }
  | { metodo: "or"; expressao: string }
  | { metodo: "imatch"; coluna: string; regex: string }
  | { metodo: "contains"; coluna: string; valor: string }
  | { metodo: "overlaps"; coluna: string; valor: string };

/** Valor entre aspas para `or(...)` e literal de array: `\` e `"` escapados. */
export function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Literal de array do Postgres com cada etiqueta entre aspas: `{"a,b","c"}`. */
export function literalDeTags(tags: string[]): string {
  return `{${tags.map(citar).join(",")}}`;
}

/**
 * O valor de "contém" como expressão regular LITERAL: todo metacaractere de
 * regex do Postgres escapado com `\`. `%` e `_` não são metacaracteres de regex
 * — ficam como estão, e são texto. Sem âncoras: "contém" é achar em qualquer
 * posição.
 *
 * Por que regex e não LIKE: o PostgREST troca TODO `*` de um padrão
 * `like`/`ilike` por `%`, sem forma de escapar — "a*b" viraria curinga. O
 * `imatch` (`~*`, sem caixa) é repassado intacto.
 */
export function regexDeContem(valor: string): string {
  return valor.replace(/[\\.^$|?*+()[\]{}]/g, (c) => `\\${c}`);
}

function colunaDoCampo(key: string): string {
  // O schema já recusa chave fora da regra; a checagem repete AQUI porque esta
  // função é a última porta antes de a chave virar nome de coluna.
  if (!CHAVE_DE_CAMPO.test(key)) throw new Error(`segmento: chave de campo inválida: ${JSON.stringify(key)}`);
  return `custom_fields->>${key}`;
}

/**
 * Um critério de campo como TERMO de `or(...)` — o grupo OU e a negação usam
 * esta forma. Cada valor vai entre aspas.
 */
function termoDoCampo(c: CriterioDeCampo): string {
  const col = colunaDoCampo(c.key);
  switch (c.op) {
    case "eq":
      return `${col}.eq.${citar(c.value)}`;
    case "neq":
      // "diferente de X" inclui quem NÃO TEM o campo (null nunca é <>).
      return `or(${col}.neq.${citar(c.value)},${col}.is.null)`;
    case "contains":
      return `${col}.imatch.${citar(regexDeContem(c.value))}`;
    case "not_contains":
      return `or(${col}.not.imatch.${citar(regexDeContem(c.value))},${col}.is.null)`;
    case "set":
      return `${col}.not.is.null`;
    case "unset":
      return `${col}.is.null`;
  }
}

/** Um critério de campo do grupo E, como filtro próprio (fora de `or`). */
function filtroDoCampo(c: CriterioDeCampo): FiltroDoSegmento {
  const col = colunaDoCampo(c.key);
  switch (c.op) {
    case "eq":
      // `.eq()` manda o valor como parâmetro da query: vírgula e aspas não
      // viram sintaxe fora de uma lista.
      return { metodo: "eq", coluna: col, valor: c.value };
    case "contains":
      return { metodo: "imatch", coluna: col, regex: regexDeContem(c.value) };
    case "set":
      return { metodo: "not", coluna: col, operador: "is", valor: null };
    case "unset":
      return { metodo: "is", coluna: col };
    case "neq":
    case "not_contains":
      // Estes precisam de "ou vazio" junto — é um `or` de dois termos.
      return { metodo: "or", expressao: termoDoCampo(c).replace(/^or\((.*)\)$/, "$1") };
  }
}

/**
 * O segmento como lista de filtros. PURA — é a expressão inteira, e é o que a
 * contagem, a listagem e a tela compartilham.
 */
export function filtrosDoSegmento(organizationId: string, segmento: Partial<Segmento> | null | undefined): FiltroDoSegmento[] {
  const s: Segmento = { ...SEGMENTO_VAZIO, ...(segmento ?? {}) };
  const f: FiltroDoSegmento[] = [
    { metodo: "eq", coluna: "organization_id", valor: organizationId },
    { metodo: "eq", coluna: "is_blocked", valor: false },
    { metodo: "eq", coluna: "is_anonymized", valor: false },
    { metodo: "is", coluna: "is_merged_into" },
    { metodo: "not", coluna: "phone_number", operador: "is", valor: null },
  ];

  // ── Grupo E ──
  // `cs` (@>): TODAS as etiquetas da lista estão no contato.
  if (s.tags_all.length) f.push({ metodo: "contains", coluna: "tags", valor: literalDeTags(s.tags_all) });
  for (const c of s.fields) f.push(filtroDoCampo(c));

  // ── Grupo OU: um `or(...)` só, com as etiquetas (`ov`, basta uma) e os campos ──
  const ou: string[] = [];
  if (s.tags_any.length) ou.push(`tags.ov.${citar(literalDeTags(s.tags_any))}`);
  for (const c of s.fields_any) ou.push(termoDoCampo(c));
  if (ou.length) f.push({ metodo: "or", expressao: ou.join(",") });

  // ── Grupo NÃO: NENHUMA etiqueta da lista, e NENHUM critério vale ──
  // NÃO(a OU b) = NÃO a E NÃO b — cada critério vira sua negação, dentro do
  // mesmo vocabulário de operadores (`NEGACAO_DO_OPERADOR`).
  if (s.tags_none.length) f.push({ metodo: "not", coluna: "tags", operador: "ov", valor: literalDeTags(s.tags_none) });
  for (const c of s.fields_none) f.push(filtroDoCampo({ ...c, op: NEGACAO_DO_OPERADOR[c.op] }));

  return f;
}

/**
 * Pendura os filtros no builder. `select` é parâmetro porque a prévia pede
 * contagem (`head: true`) e a materialização pede as linhas — mudar isso não
 * pode significar reescrever os filtros.
 */
function aplicar(
  db: SupabaseClient,
  organizationId: string,
  segmento: Segmento,
  select: string,
  opcoes?: { count?: "exact"; head?: boolean },
) {
  const base = db.from("contacts").select(select, opcoes);
  let q = base as unknown as Filtros;
  for (const f of filtrosDoSegmento(organizationId, segmento)) {
    switch (f.metodo) {
      case "eq":
        q = q.eq(f.coluna, f.valor);
        break;
      case "is":
        q = q.is(f.coluna, null);
        break;
      case "not":
        q = q.not(f.coluna, f.operador, f.valor);
        break;
      case "or":
        q = q.or(f.expressao);
        break;
      case "imatch":
        q = q.filter(f.coluna, "imatch", f.regex);
        break;
      case "contains":
        // String, e não array: o `supabase-js` junta array com vírgula SEM
        // escapar, e uma etiqueta com vírgula viraria duas.
        q = q.contains(f.coluna, f.valor);
        break;
      case "overlaps":
        q = q.overlaps(f.coluna, f.valor);
        break;
    }
  }
  return q as unknown as typeof base;
}

/** Quantas pessoas este segmento alcança AGORA. Para a prévia, antes do clique. */
export async function contarPublico(
  db: SupabaseClient,
  organizationId: string,
  segmento: Segmento,
): Promise<{ total: number; erro: string | null }> {
  const { count, error } = await aplicar(db, organizationId, segmento, "id", {
    count: "exact",
    head: true,
  });
  if (error) return { total: 0, erro: error.message };
  return { total: count ?? 0, erro: null };
}

interface ContatoDoPublico {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  tags: string[] | null;
  custom_fields: Record<string, unknown> | null;
}

/**
 * As pessoas do segmento, em páginas. `limite` existe porque um disparo para
 * 50.000 contatos não cabe numa resposta do PostgREST — e porque a
 * materialização insere em lotes de qualquer jeito.
 */
export async function listarPublico(
  db: SupabaseClient,
  organizationId: string,
  segmento: Segmento,
  opcoes: { limite: number; offset: number },
): Promise<{ contatos: ContatoDoPublico[]; erro: string | null }> {
  const { data, error } = await aplicar(db, organizationId, segmento, COLUNAS_DO_PUBLICO)
    .order("created_at", { ascending: true })
    .range(opcoes.offset, opcoes.offset + opcoes.limite - 1);
  if (error) return { contatos: [], erro: error.message };
  return { contatos: (data ?? []) as unknown as ContatoDoPublico[], erro: null };
}

const SIMBOLO: Record<CriterioDeCampo["op"], string> = {
  eq: "=",
  neq: "≠",
  contains: "contém",
  not_contains: "não contém",
  set: "preenchido",
  unset: "vazio",
};

function frase(c: CriterioDeCampo): string {
  return c.op === "set" || c.op === "unset" ? `${c.key} ${SIMBOLO[c.op]}` : `${c.key} ${SIMBOLO[c.op]} "${c.value}"`;
}

/**
 * A EXPRESSÃO lógica do segmento, grupo a grupo — o que a tela mostra ao lado da
 * contagem. Sai da mesma estrutura que `filtrosDoSegmento` traduz, na mesma
 * ordem: E, depois OU, depois NÃO.
 */
export function expressaoDoSegmento(segmento: Partial<Segmento> | null | undefined): string[] {
  const s: Segmento = { ...SEGMENTO_VAZIO, ...(segmento ?? {}) };
  const partes: string[] = [];
  const e = [...s.tags_all.map((t) => `tem "${t}"`), ...s.fields.map(frase)];
  if (e.length) partes.push(`TODAS: ${e.join(" E ")}`);
  const ou = [...s.tags_any.map((t) => `tem "${t}"`), ...s.fields_any.map(frase)];
  if (ou.length) partes.push(`PELO MENOS UMA: ${ou.join(" OU ")}`);
  const nao = [...s.tags_none.map((t) => `tem "${t}"`), ...s.fields_none.map(frase)];
  if (nao.length) partes.push(`NENHUMA: ${nao.join(" OU ")}`);
  return partes;
}

/** Descreve o segmento em uma frase, para a lista e para o audit log. */
export function resumoDoSegmento(segmento: Partial<Segmento> | null | undefined): string {
  const s: Segmento = { ...SEGMENTO_VAZIO, ...(segmento ?? {}) };
  const partes: string[] = [];
  if (s.tags_all.length) partes.push(`com ${s.tags_all.join(" e ")}`);
  if (s.tags_any.length) partes.push(`com ${s.tags_any.join(" ou ")}`);
  if (s.tags_none.length) partes.push(`sem ${s.tags_none.join(" nem ")}`);
  for (const f of s.fields) {
    if (f.op === "set") partes.push(`${f.key} preenchido`);
    else if (f.op === "unset") partes.push(`${f.key} vazio`);
    else partes.push(`${f.key} ${f.op === "neq" ? "≠" : f.op === "contains" ? "~" : f.op === "not_contains" ? "!~" : "="} ${f.value}`);
  }
  if (s.fields_any.length) partes.push(`ou: ${s.fields_any.map(frase).join(" ou ")}`);
  if (s.fields_none.length) partes.push(`nenhum de: ${s.fields_none.map(frase).join(", ")}`);
  return partes.length ? partes.join(", ") : "Nenhum critério — o disparo não tem público.";
}
