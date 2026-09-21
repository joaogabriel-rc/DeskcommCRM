/**
 * Schemas do REGISTRO de campos do contato (migration 0383).
 *
 * ── A chave não é o nome ─────────────────────────────────────────────────────
 *
 * `key` é o identificador estável: é a chave dentro de `contacts.custom_fields`
 * e é o que `{{contact.custom_fields.<key>}}` cita dentro de uma mensagem de
 * flow já publicada. Por isso ela é aceita só na CRIAÇÃO — `atualizarCampoSchema`
 * não a tem. `label` é o nome na tela e muda à vontade, sem quebrar nada.
 *
 * O `id` uuid serve às integrações (N8N, API): uma automação de fora pode
 * guardar o uuid e continuar apontando para o mesmo campo depois de qualquer
 * renomeação.
 */
import { z } from "zod";

/**
 * Os seis tipos que a TELA oferece. O banco aceita mais (o vocabulário legado
 * de `crm_pipelines.settings.fields[]`, que o backfill da 0383 trouxe), e a
 * tela mostra esses como somente-leitura em vez de fingir que não existem.
 */
export const TIPOS_DE_CAMPO = ["text", "number", "date", "datetime", "boolean", "list"] as const;
export type TipoDeCampo = (typeof TIPOS_DE_CAMPO)[number];

/** Inclui o legado. É o que a leitura precisa aceitar para não descartar linha. */
export const TIPOS_DE_CAMPO_ACEITOS = [
  ...TIPOS_DE_CAMPO,
  "textarea",
  "select",
  "multiselect",
  "email",
  "phone",
  "url",
] as const;
export type TipoDeCampoAceito = (typeof TIPOS_DE_CAMPO_ACEITOS)[number];

export const TIPO_DE_CAMPO_LABEL: Record<TipoDeCampoAceito, string> = {
  text: "Texto",
  number: "Número",
  date: "Data",
  datetime: "Data e hora",
  boolean: "Verdadeiro/Falso",
  list: "Matriz",
  textarea: "Texto longo",
  select: "Escolha única",
  multiselect: "Escolha múltipla",
  email: "E-mail",
  phone: "Telefone",
  url: "Link",
};

export const CHAVE_DE_CAMPO = /^[a-z][a-z0-9_]{0,39}$/;

export const chaveDeCampoSchema = z
  .string({ error: "chave_obrigatoria" })
  .trim()
  .toLowerCase()
  .regex(CHAVE_DE_CAMPO, "chave_invalida");

export const criarCampoSchema = z.object({
  key: chaveDeCampoSchema,
  label: z.string().trim().min(1, "nome_obrigatorio").max(80, "nome_longo_demais"),
  description: z.string().trim().max(500).nullish(),
  type: z.enum(TIPOS_DE_CAMPO).default("text"),
  folder: z.string().trim().min(1).max(60).default("Campos do Usuário"),
  options: z
    .array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(80) }))
    .max(50)
    .default([]),
});
export type CriarCampoInput = z.infer<typeof criarCampoSchema>;

/**
 * Sem `key`, e é a regra inteira desta fatia: renomear um campo NÃO pode mudar
 * a chave, senão toda mensagem publicada que a cita passa a renderizar vazio.
 */
export const atualizarCampoSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullish(),
  type: z.enum(TIPOS_DE_CAMPO).optional(),
  folder: z.string().trim().min(1).max(60).optional(),
  options: z
    .array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(80) }))
    .max(50)
    .optional(),
  position: z.number().finite().optional(),
  /** `true` arquiva, `false` desarquiva. Arquivar nunca apaga o VALOR no contato. */
  archived: z.boolean().optional(),
});
export type AtualizarCampoInput = z.infer<typeof atualizarCampoSchema>;

/** Uma linha do registro, como a tela e a API a devolvem. */
export interface CampoDoContato {
  id: string;
  key: string;
  label: string;
  description: string | null;
  type: TipoDeCampoAceito;
  options: Array<{ value: string; label: string }>;
  folder: string;
  archived_at: string | null;
  position: number;
}

/**
 * Sugere uma chave a partir do nome digitado — sem acento, minúscula, com
 * underscore. É só CONVENIÊNCIA da tela: quem manda é o que o usuário aceitar,
 * e depois de criado ninguém mais muda.
 */
export function sugerirChave(nome: string): string {
  const semAcento = nome.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const bruto = semAcento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!bruto) return "";
  // A chave tem de COMEÇAR com letra (CHECK do banco): "3d" viraria chave
  // inválida e o erro só apareceria no clique de salvar.
  return /^[a-z]/.test(bruto) ? bruto : `campo_${bruto}`.slice(0, 40);
}
