import { z } from "zod";
import { FLOW_NODE_TYPES } from "@/lib/flows/types";
import { FLOW_TRIGGER_IDS } from "@/lib/flows/triggers";

/**
 * O gatilho é do FLOW, e é escolhido na tela — por isso ele entra no create
 * com um default explícito (tag), e não como se fosse a natureza do flow.
 * `trigger_config` é livre por gatilho (tag, campo, etapa, palavra-chave):
 * quem sabe o que cada um precisa é o catálogo em `lib/flows/triggers.ts`, e a
 * validação de obrigatoriedade acontece ao ATIVAR, não ao rascunhar.
 */
export const createFlowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  trigger_type: z.enum(FLOW_TRIGGER_IDS).default("contact_tag_added"),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateFlowInput = z.infer<typeof createFlowSchema>;

export const updateFlowSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  trigger_type: z.enum(FLOW_TRIGGER_IDS).optional(),
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
