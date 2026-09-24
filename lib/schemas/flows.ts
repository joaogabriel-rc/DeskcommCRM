import { z } from "zod";
import { FLOW_NODE_TYPES } from "@/lib/flows/types";
import { FLOW_TRIGGER_IDS_ESCOLHIVEIS } from "@/lib/flows/triggers";

/**
 * O fluxo nasce no CONSTRUTOR, e o gatilho é escolhido DENTRO dele, no nó
 * "Quando…". Por isso o create não exige gatilho: sem ele, o fluxo é um
 * rascunho com `trigger_type` nulo (migration 0393) — nunca um default
 * plausível, que faria o rascunho dizer que escuta "tag atribuída" sem tag.
 * Quem cria já sabendo o gatilho (API, integração) ainda pode mandá-lo.
 * `trigger_config` é livre por gatilho (tag, campo, etapa, palavra-chave):
 * quem sabe o que cada um precisa é o catálogo em `lib/flows/triggers.ts`, e a
 * validação de obrigatoriedade acontece ao ATIVAR, não ao rascunhar.
 */
export const createFlowSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Sem título"),
  description: z.string().max(2000).optional(),
  // Só os gatilhos ESCOLHÍVEIS: o `broadcast` nasce com o disparo (0399), nunca por aqui.
  trigger_type: z.enum(FLOW_TRIGGER_IDS_ESCOLHIVEIS).nullish(),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateFlowInput = z.infer<typeof createFlowSchema>;

export const updateFlowSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  trigger_type: z.enum(FLOW_TRIGGER_IDS_ESCOLHIVEIS).optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateFlowInput = z.infer<typeof updateFlowSchema>;

const flowNodeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(FLOW_NODE_TYPES),
  label: z.string().max(120).default(""),
  config: z.record(z.string(), z.unknown()).default({}),
  position_x: z.number().finite(),
  position_y: z.number().finite(),
});

const flowEdgeSchema = z.object({
  id: z.string().uuid(),
  source_node_id: z.string().uuid(),
  target_node_id: z.string().uuid(),
  source_handle: z.string().max(40).nullable().optional(),
});

export const replaceFlowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema).max(200),
  edges: z.array(flowEdgeSchema).max(400),
});
export type ReplaceFlowGraphInput = z.infer<typeof replaceFlowGraphSchema>;
