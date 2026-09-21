/**
 * Schemas do vocabulário de etiquetas (issue #852, fatia S4; cor: #1271, S6).
 *
 * A etiqueta continua sendo `text[]` onde já está — automação, webhook
 * (`lead.tag_added`) e MCP (`*.tags_changed`) falam em string há versões, e
 * trocar por tabela com FK quebraria os três contratos. O que entra aqui é só a
 * validação do que a TELA manda para a função de banco.
 *
 * ── A cor entra neste arquivo, e não na tela ─────────────────────────────────
 *
 * A validação de forma (`#rrggbb`) precisa acontecer onde a rota pode recusar
 * antes de chamar o banco: a função de operação também valida (`cor_invalida`,
 * 22023), mas quem chega por RPC direta não passa por aqui — as duas camadas
 * existem de propósito, e a de baixo é a que vale para o dado gravado.
 */
import { z } from "zod";

import { corDeEtiquetaValida, normalizarCorDeEtiqueta } from "@/lib/tags/cor-da-etiqueta";

/**
 * O teto é o mesmo do editor de etiquetas do Inbox (`conversationTagSchema`),
 * de propósito: uma etiqueta que cabe no vocabulário mas não cabe no seletor
 * seria um nome que a tela cria e não consegue oferecer.
 */
export const TAG_MAX = 60;

/** Ações do vocabulário. Cada uma é uma operação atômica do banco. */
export const ACOES_DE_VOCABULARIO = ["renomear", "juntar", "excluir", "definir_cor"] as const;
export type AcaoDeVocabulario = (typeof ACOES_DE_VOCABULARIO)[number];

export const tagSchema = z
  .string({ error: "tag_obrigatoria" })
  .trim()
  .min(1, "tag_obrigatoria")
  .max(TAG_MAX, "tag_longa_demais");

/**
 * A cor, na forma que o banco aceita: normalizada para `#rrggbb` minúsculo.
 *
 * `#ABC`, `#aabbcc` e `aabbcc` entram e saem iguais (`#aabbcc`): a régua é a
 * mesma função que a LEITURA usa para tolerar o que já estiver gravado à mão.
 * O que não entra é lixo (`nome-verde`, `#12345`), que gravaria e voltaria para
 * a tela sem pintar nada.
 *
 * "Sem cor" é `cor: null`, não string vazia — quem limpa diz que está limpando.
 */
export const corDeEtiquetaSchema = z
  .string({ error: "cor_invalida" })
  .trim()
  .refine((valor) => corDeEtiquetaValida(valor), { error: "cor_invalida" })
  .transform((valor) => normalizarCorDeEtiqueta(valor) as string);

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
    cor: corDeEtiquetaSchema.nullish(),
  })
  .superRefine((valor, ctx) => {
    if (valor.acao === "definir_cor") {
      // Presente-e-nula é pedido legítimo ("tirar a cor"); AUSENTE é erro de
      // quem chamou: sem o campo não dá para distinguir "limpe" de "esqueci de
      // mandar", e a operação diria que alterou quando não alterou nada.
      if (valor.cor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cor"],
          message: "cor_obrigatoria",
        });
      }
      if (valor.destino != null) {
        // `definir_cor` não renomeia: aceitar um destino aqui faria a tela
        // prometer duas coisas e a função fazer uma.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destino"],
          message: "destino_invalido_para_acao",
        });
      }
      return;
    }
    if (valor.cor != null) {
      // Renomear/juntar/excluir não falam de cor. Ignorar em silêncio deixaria a
      // tela acreditar que mandou uma cor junto.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cor"],
        message: "cor_invalida_para_acao",
      });
      return;
    }
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
 * O REGISTRO de etiquetas (migration 0383) — a tag como ENTIDADE, com id.
 *
 * O que muda em relação ao bloco acima: ali a etiqueta só existia depois de
 * alguém escrevê-la em algum lugar, e a tela mostrava o que já tinha sido
 * escrito. Aqui ela pode ser CRIADA antes do primeiro uso, ganha pasta e ganha
 * um `id` uuid que uma integração (N8N, API) cita sem depender da grafia.
 *
 * O que NÃO muda: a etiqueta continua sendo string dentro de `contacts.tags`.
 * O registro é a IDENTIDADE da etiqueta; o valor aplicado segue onde sempre
 * esteve.
 *
 * ⚠️ Cor e descrição NÃO entram aqui. São atributos do vocabulário, em
 * `organizations.settings.tags[]` (migration 0336): quem escreve é a ação
 * `definir_cor` de `POST /api/v1/tags/vocabulario` (bloco acima), e quem lê é
 * `lib/tags/cor-da-etiqueta.ts`. Aceitar `color` neste schema criaria uma
 * segunda fonte da mesma cor, e o chip do Inbox continuaria lendo a primeira.
 * ──────────────────────────────────────────────────────────────────────────── */

export const PASTA_MAX = 60;
export const PASTA_PADRAO = "Tags";

export const criarTagSchema = z.object({
  name: tagSchema,
  folder: z.string().trim().min(1).max(PASTA_MAX).default(PASTA_PADRAO),
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
  archived: z.boolean().optional(),
});
export type AtualizarTagInput = z.infer<typeof atualizarTagSchema>;

/** Uma linha do registro, como a tela e a API a devolvem. */
export interface TagDoRegistro {
  id: string;
  name: string;
  folder: string;
  archived_at: string | null;
}
