/**
 * Quais campos personalizados o FORMULÁRIO DO CONTATO mostra.
 *
 * ── Duas fontes, e nenhuma pode ser descartada ──────────────────────────────
 *
 * Desde a migration 0389 a definição de campo do contato mora em
 * `public.contact_fields` — com id, tipo, pasta e arquivamento. Antes dela, a
 * única declaração possível era `crm_pipelines.settings.fields[]`, e é de lá
 * que vêm os campos de quem já usava o produto.
 *
 * O backfill da 0389 copiou os campos do funil para o registro, preservando a
 * chave. Mas copiar uma vez não basta: o funil continua EDITÁVEL em
 * Configurações › Funis, e um campo acrescentado lá depois da atualização não
 * passa por lugar nenhum que alimente o registro. Descartá-lo aqui faria um
 * campo visível numa tela sumir de outra, sem aviso.
 *
 * Então as duas fontes entram, e o REGISTRO vence no empate — porque é ele que
 * tem o tipo que a tela nova editou, a pasta e o estado de arquivamento.
 *
 * ── Arquivado sai do formulário, mas o VALOR continua ───────────────────────
 *
 * Arquivar é "parei de usar isto", não "apague". O campo some do formulário e
 * o que já estava gravado em `contacts.custom_fields` fica intacto — inclusive
 * para a variável de uma mensagem publicada que ainda o cite.
 */
import type { CustomFieldDef, CustomFieldType } from "@/components/contacts/CustomFieldsEditor";
import type { CampoDoContato } from "@/lib/schemas/contact-fields";

/**
 * Os tipos que o REGISTRO aceita e que o editor sabe desenhar são os mesmos —
 * o CHECK da 0389 foi escrito a partir desta lista, somando os seis tipos da
 * tela nova ao vocabulário legado do funil. Este mapa existe para o dia em que
 * divergirem: um tipo desconhecido vira `text`, que é editável e não perde
 * dado, em vez de derrubar a tela com um `switch` sem caso.
 */
const TIPOS_DO_EDITOR = new Set<string>([
  "text",
  "textarea",
  "number",
  "date",
  "datetime",
  "select",
  "multiselect",
  "boolean",
  "list",
  "email",
  "phone",
  "url",
]);

function tipoDoEditor(tipo: string): CustomFieldType {
  return (TIPOS_DO_EDITOR.has(tipo) ? tipo : "text") as CustomFieldType;
}

/** Uma linha do registro vira a definição que o editor consome. */
export function doRegistro(campo: CampoDoContato): CustomFieldDef {
  return {
    key: campo.key,
    label: campo.label,
    type: tipoDoEditor(campo.type),
    options: campo.options?.length ? campo.options : undefined,
  };
}

/**
 * A lista que o formulário do contato mostra: registro + legado do funil,
 * uma entrada por chave.
 *
 * A ordem é a do REGISTRO primeiro (é ela que o operador arruma na tela nova,
 * com `position`), e os legados que sobraram no fim — eles não têm ordenação
 * declarada, e inventar uma faria a lista dançar entre dois carregamentos.
 */
export function camposDoContato(
  registro: CampoDoContato[] | undefined,
  legadoDoFunil: CustomFieldDef[] | undefined,
): CustomFieldDef[] {
  const ativos = (registro ?? []).filter((c) => !c.archived_at);
  const vistas = new Set(ativos.map((c) => c.key.toLowerCase()));
  const doFunil = (legadoDoFunil ?? []).filter((f) => !vistas.has(f.key.toLowerCase()));
  return [...ativos.map(doRegistro), ...doFunil];
}
