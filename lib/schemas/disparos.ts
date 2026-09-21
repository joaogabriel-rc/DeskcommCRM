/**
 * Schemas dos DISPAROS — envio em massa de WhatsApp (migration 0383).
 *
 * A mensagem usa o MESMO vocabulário do nó MESSAGE do flow
 * (`lib/flows/types.ts`): `window_mode`, `body`, `template_*`. Um só jeito de
 * dizer "mande WhatsApp" no produto inteiro — se a janela de 24h mudar de
 * regra, muda num lugar.
 *
 * A segmentação é a mesma estrutura que `lib/disparos/segmento.ts` traduz para
 * uma query, e a mesma que a prévia de público conta antes de disparar.
 */
import { z } from "zod";

export const OPERADORES_DE_CAMPO = ["eq", "neq", "contains", "set", "unset"] as const;
export type OperadorDeCampo = (typeof OPERADORES_DE_CAMPO)[number];

export const OPERADOR_DE_CAMPO_LABEL: Record<OperadorDeCampo, string> = {
  eq: "é igual a",
  neq: "é diferente de",
  contains: "contém",
  set: "está preenchido",
  unset: "está vazio",
};

/**
 * O critério de CAMPO aponta pela CHAVE (`key`), não pelo uuid, porque é a
 * chave que indexa `contacts.custom_fields` — o filtro vira `custom_fields->>key`
 * direto no Postgres. Como a chave é imutável (0383), ela é tão estável quanto
 * o id para este fim.
 */
export const criterioDeCampoSchema = z.object({
  key: z.string().trim().min(1).max(40),
  op: z.enum(OPERADORES_DE_CAMPO).default("eq"),
  value: z.string().trim().max(200).default(""),
});
export type CriterioDeCampo = z.infer<typeof criterioDeCampoSchema>;

export const segmentoSchema = z.object({
  /** Precisa ter TODAS estas etiquetas. */
  tags_all: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Basta ter UMA destas. */
  tags_any: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Não pode ter NENHUMA destas — é o que exclui quem já comprou, quem pediu para sair. */
  tags_none: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  fields: z.array(criterioDeCampoSchema).max(20).default([]),
});
export type Segmento = z.infer<typeof segmentoSchema>;

export const SEGMENTO_VAZIO: Segmento = { tags_all: [], tags_any: [], tags_none: [], fields: [] };

export const mensagemDeDisparoSchema = z.object({
  window_mode: z.enum(["inside_24h", "outside_24h"]).default("outside_24h"),
  body: z.string().max(4000).default(""),
  template_name: z.string().trim().max(120).nullish(),
  template_language: z.string().trim().max(20).nullish(),
  template_values: z.record(z.string(), z.string().max(1000)).default({}),
  channel_session_id: z.string().trim().max(120).nullish(),
});
export type MensagemDeDisparo = z.infer<typeof mensagemDeDisparoSchema>;

export const criarDisparoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  segment: segmentoSchema.default(SEGMENTO_VAZIO),
  message: mensagemDeDisparoSchema.default({
    window_mode: "outside_24h",
    body: "",
    template_values: {},
  }),
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
});
export type CriarDisparoInput = z.infer<typeof criarDisparoSchema>;

/**
 * As transições que a TELA pede. Os estados terminais e os intermediários que
 * só o worker escreve (`running`, `completed`, `failed`) não entram aqui: quem
 * os grava é o motor, e aceitá-los da borda deixaria a tela marcar como
 * concluído um disparo que não enviou nada.
 */
export const ACOES_DE_DISPARO = ["agendar", "pausar", "retomar", "cancelar"] as const;
export type AcaoDeDisparo = (typeof ACOES_DE_DISPARO)[number];

export const atualizarDisparoSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  segment: segmentoSchema.optional(),
  message: mensagemDeDisparoSchema.optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
  acao: z.enum(ACOES_DE_DISPARO).optional(),
});
export type AtualizarDisparoInput = z.infer<typeof atualizarDisparoSchema>;

export type StatusDeDisparo =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export const STATUS_DE_DISPARO_LABEL: Record<StatusDeDisparo, string> = {
  draft: "Rascunho",
  scheduled: "Agendado",
  running: "Enviando",
  paused: "Pausado",
  completed: "Concluído",
  cancelled: "Cancelado",
  failed: "Falhou",
};

export interface DisparoRow {
  id: string;
  organization_id: string;
  name: string;
  status: StatusDeDisparo;
  segment: Segmento;
  message: MensagemDeDisparo;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Um disparo só pode ser agendado quando tem público E mensagem. A checagem
 * mora aqui, e não na rota, porque a TELA precisa da mesma resposta para
 * desabilitar o botão antes do clique — regra duplicada em dois lugares é regra
 * que diverge.
 */
export function porQueNaoPodeAgendar(
  disparo: Pick<DisparoRow, "segment" | "message">,
): string | null {
  const s = disparo.segment ?? SEGMENTO_VAZIO;
  const temFiltro =
    (s.tags_all?.length ?? 0) + (s.tags_any?.length ?? 0) + (s.fields?.length ?? 0) > 0;
  if (!temFiltro) {
    // `tags_none` sozinho não conta: "todo mundo menos quem tem a tag X" é o
    // disparo para a base inteira, e ninguém faz isso sem querer.
    return "Escolha ao menos um critério de público — uma tag ou um campo.";
  }
  const m = disparo.message;
  if (m?.window_mode === "outside_24h") {
    if (!m.template_name || !m.template_language) {
      return "Fora da janela de 24 horas, a plataforma só aceita template aprovado: informe o nome e o idioma.";
    }
    return null;
  }
  if (!m?.body?.trim()) return "Escreva o texto da mensagem.";
  return null;
}
