/**
 * Schemas do vocabulário de etiquetas (issue #852, fatia S4).
 *
 * A etiqueta continua sendo `text[]` onde já está — automação, webhook
 * (`lead.tag_added`) e MCP (`*.tags_changed`) falam em string há versões, e
 * trocar por tabela com FK quebraria os três contratos. O que entra aqui é só a
 * validação do que a TELA manda para a função de banco.
 */
import { z } from "zod";

/**
 * O teto é o mesmo do editor de etiquetas do Inbox (`conversationTagSchema`),
 * de propósito: uma etiqueta que cabe no vocabulário mas não cabe no seletor
 * seria um nome que a tela cria e não consegue oferecer.
 */
export const TAG_MAX = 60;

/** Ações do vocabulário. Cada uma é uma operação atômica do banco. */
export const ACOES_DE_VOCABULARIO = ["renomear", "juntar", "excluir"] as const;
export type AcaoDeVocabulario = (typeof ACOES_DE_VOCABULARIO)[number];

export const tagSchema = z
  .string({ error: "tag_obrigatoria" })
  .trim()
  .min(1, "tag_obrigatoria")
  .max(TAG_MAX, "tag_longa_demais");

/**
 * `juntar` é o único caso em que a tag de origem e o destino podem coexistir com
 * grafias diferentes ("vip" + "VIP" → "VIP"): a função de banco desduplica por
 * nome canônico, então aqui só se exige que o destino exista e seja diferente.
 */
export const vocabularioDeTagsSchema = z
  .object({
    acao: z.enum(ACOES_DE_VOCABULARIO, {
      error: "acao_invalida",
    }),
    tag: tagSchema,
    destino: tagSchema.nullish(),
  })
  .superRefine((valor, ctx) => {
    if (valor.acao === "excluir") return;
    if (!valor.destino) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_obrigatorio",
      });
      return;
    }
    if (
      valor.acao === "renomear" &&
      valor.destino.toLowerCase() === valor.tag.toLowerCase()
    ) {
      // Renomear para o mesmo nome (mesmo com outra caixa) não é operação: a
      // função de banco devolveria `alterou: false` e a tela diria "nada mudou"
      // sem explicar por quê.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_igual_a_tag",
      });
    }
  });

export type VocabularioDeTagsInput = z.infer<typeof vocabularioDeTagsSchema>;

/** Uma linha do vocabulário, como a função de leitura devolve. */
export type LinhaDeVocabulario = {
  tag: string;
  uso_em_contatos: number;
  uso_em_leads: number;
  uso_em_conversas: number;
  em_regras: number;
  cor: string | null;
  descricao: string | null;
  no_vocabulario: boolean;
};

/* ────────────────────────────────────────────────────────────────────────────
 * O REGISTRO de etiquetas (migration 0312) — a tag como ENTIDADE, com id.
 *
 * O que muda em relação ao bloco acima: ali a etiqueta só existia depois de
 * alguém escrevê-la em algum lugar, e a tela mostrava o que já tinha sido
 * escrito. Aqui ela pode ser CRIADA antes do primeiro uso, ganha pasta, cor e
 * descrição, e ganha um `id` uuid que uma integração (N8N, API) cita sem
 * depender da grafia.
 *
 * O que NÃO muda: a etiqueta continua sendo string dentro de `contacts.tags`.
 * O registro é o vocabulário; o valor aplicado segue onde sempre esteve.
 * ──────────────────────────────────────────────────────────────────────────── */

export const PASTA_MAX = 60;
export const PASTA_PADRAO = "Tags";

export const criarTagSchema = z.object({
  name: tagSchema,
  folder: z.string().trim().min(1).max(PASTA_MAX).default(PASTA_PADRAO),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "cor_invalida")
    .nullish(),
  description: z.string().trim().max(500).nullish(),
});
export type CriarTagInput = z.infer<typeof criarTagSchema>;

/**
 * `name` ENTRA aqui, ao contrário de `key` no registro de campos — e a razão é
 * a diferença entre os dois: o nome da tag É o valor aplicado, então renomear
 * exige reescrever `contacts.tags` de todo mundo. Quem faz isso numa transação
 * só é `fn_vocabulario_de_tags_operar` (0264); por isso a rota de PATCH manda o
 * rename por lá e só depois sincroniza o registro, preservando o id.
 */
export const atualizarTagSchema = z.object({
  name: tagSchema.optional(),
  folder: z.string().trim().min(1).max(PASTA_MAX).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "cor_invalida")
    .nullish(),
  description: z.string().trim().max(500).nullish(),
  archived: z.boolean().optional(),
});
export type AtualizarTagInput = z.infer<typeof atualizarTagSchema>;

/** Uma linha do registro, como a tela e a API a devolvem. */
export interface TagDoRegistro {
  id: string;
  name: string;
  folder: string;
  color: string | null;
  description: string | null;
  archived_at: string | null;
}
