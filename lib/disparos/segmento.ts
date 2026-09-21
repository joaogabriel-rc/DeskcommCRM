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
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { SEGMENTO_VAZIO, type Segmento } from "@/lib/schemas/disparos";

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
  ilike(coluna: string, padrao: string): Filtros;
  contains(coluna: string, valor: unknown): Filtros;
  overlaps(coluna: string, valor: unknown): Filtros;
}

/**
 * Monta a query base. `select` é parâmetro porque a prévia pede contagem
 * (`head: true`) e a materialização pede as linhas — mudar isso não pode
 * significar reescrever os filtros.
 */
function aplicar(
  db: SupabaseClient,
  organizationId: string,
  segmento: Segmento,
  select: string,
  opcoes?: { count?: "exact"; head?: boolean },
) {
  const base = db.from("contacts").select(select, opcoes);
  let q = (base as unknown as Filtros)
    .eq("organization_id", organizationId)
    .eq("is_blocked", false)
    .eq("is_anonymized", false)
    .is("is_merged_into", null)
    .not("phone_number", "is", null);

  const s = { ...SEGMENTO_VAZIO, ...(segmento ?? {}) };

  // `contains` é o operador de array do Postgres (@>): TODAS as etiquetas da
  // lista precisam estar no contato.
  if (s.tags_all.length) q = q.contains("tags", s.tags_all);
  // `overlaps` (&&): basta uma em comum.
  if (s.tags_any.length) q = q.overlaps("tags", s.tags_any);
  // A negação não tem operador direto no builder: `not(col, 'ov', ...)` é o
  // "NÃO tem nenhuma destas".
  if (s.tags_none.length) q = q.not("tags", "ov", `{${s.tags_none.map(escaparTag).join(",")}}`);

  for (const criterio of s.fields) {
    const coluna = `custom_fields->>${criterio.key}`;
    switch (criterio.op) {
      case "eq":
        q = q.eq(coluna, criterio.value);
        break;
      case "neq":
        // `neq` sozinho descartaria quem NÃO TEM o campo (null nunca é <>), e
        // "quem não é do plano premium" tem de incluir quem não tem plano
        // nenhum. Por isso o `or` com `is.null`.
        q = q.or(`custom_fields->>${criterio.key}.neq.${criterio.value},custom_fields->>${criterio.key}.is.null`);
        break;
      case "contains":
        q = q.ilike(coluna, `%${criterio.value}%`);
        break;
      case "set":
        q = q.not(coluna, "is", null);
        break;
      case "unset":
        q = q.is(coluna, null);
        break;
    }
  }
  return q as unknown as typeof base;
}

/**
 * Etiqueta dentro de um literal de array do Postgres. Vírgula, aspas e chave
 * dentro do nome quebrariam o literal — e etiqueta é texto que o usuário digita.
 */
function escaparTag(tag: string): string {
  return `"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

/** Descreve o segmento em uma frase, para a lista e para o audit log. */
export function resumoDoSegmento(segmento: Segmento | null | undefined): string {
  const s = { ...SEGMENTO_VAZIO, ...(segmento ?? {}) };
  const partes: string[] = [];
  if (s.tags_all.length) partes.push(`com ${s.tags_all.join(" e ")}`);
  if (s.tags_any.length) partes.push(`com ${s.tags_any.join(" ou ")}`);
  if (s.tags_none.length) partes.push(`sem ${s.tags_none.join(" nem ")}`);
  for (const f of s.fields) {
    if (f.op === "set") partes.push(`${f.key} preenchido`);
    else if (f.op === "unset") partes.push(`${f.key} vazio`);
    else partes.push(`${f.key} ${f.op === "neq" ? "≠" : f.op === "contains" ? "~" : "="} ${f.value}`);
  }
  return partes.length ? partes.join(", ") : "Nenhum critério — o disparo não tem público.";
}
