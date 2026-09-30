/**
 * As regras puras da ficha do contato — tags e campos personalizados — que o
 * diálogo "Editar contato" usa. Puras para serem medidas sem tela.
 *
 * TAG e CAMPO são coisas diferentes e continuam separadas: a tag diz o que o
 * contato É (lista em `contacts.tags`), o campo diz o que se sabe SOBRE ele
 * (mapa em `contacts.custom_fields`, declarado no registro de campos).
 */
import { normalizarTag } from "@/lib/contacts/tag-normalizada";

/**
 * Acrescenta UMA tag sem tirar as outras. Na MESMA forma que o servidor grava
 * (`normalizarTags` no `contactPatchSchema`), para o chip mostrado ser o que o
 * filtro `?tag=` casa depois — e sem repetir a que já está lá com outra caixa.
 */
export function acrescentarTag(tags: readonly string[], nome: string): string[] {
  const nova = normalizarTag(nome);
  if (!nova) return [...tags];
  if (tags.some((t) => normalizarTag(t) === nova)) return [...tags];
  return [...tags, nova];
}

/** Tira UMA tag — e só ela. */
export function removerTag(tags: readonly string[], nome: string): string[] {
  return tags.filter((t) => t !== nome);
}

/** Valor que a ficha trata como "Não definido". `false` e `0` SÃO valores. */
export function campoVazio(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * LIMPAR um campo tira a CHAVE do mapa, e não grava string vazia: o PATCH
 * substitui `custom_fields` inteiro, então o que não vai no mapa some do banco —
 * e o critério "está vazio" dos Disparos (`custom_fields->>key is null`) passa a
 * valer para ele.
 */
export function limparCampo(valores: Record<string, unknown>, chave: string): Record<string, unknown> {
  const { [chave]: _removido, ...resto } = valores;
  return resto;
}

/** Grava um valor; valor vazio vira LIMPAR (mesma regra de cima). */
export function definirCampo(
  valores: Record<string, unknown>,
  chave: string,
  valor: unknown,
): Record<string, unknown> {
  return campoVazio(valor) ? limparCampo(valores, chave) : { ...valores, [chave]: valor };
}

interface DefinicaoParaTela {
  type: string;
  options?: Array<{ value: string; label: string }>;
}

/**
 * O valor como a pessoa o LÊ na ficha, ou `null` para "Não definido". Opção de
 * lista mostra o rótulo, não o valor técnico; sim/não em português; lista
 * separada por vírgula.
 */
export function valorParaTela(
  def: DefinicaoParaTela,
  v: unknown,
  t: (texto: string) => string = (x) => x,
): string | null {
  if (campoVazio(v)) return null;
  const rotuloDaOpcao = (x: unknown) => def.options?.find((o) => o.value === String(x))?.label ?? String(x);
  if (def.type === "boolean") return v ? t("Sim") : t("Não");
  if (Array.isArray(v)) return v.map(rotuloDaOpcao).join(", ");
  if (def.type === "select") return rotuloDaOpcao(v);
  if (def.type === "datetime" && typeof v === "string") return v.slice(0, 16).replace("T", " ");
  return String(v);
}
