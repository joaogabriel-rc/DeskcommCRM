"use client";

import type { NodeProps } from "@xyflow/react";

import type { FlowNodeType, MessageNodeConfig } from "@/lib/flows/types";
import type { RFNode } from "@/lib/flows/ui-mappers";
import { describeNodeConfig, NODE_VISUALS } from "./nodeVisuals";
import { NodeCard, type NodeCardHandle } from "./NodeCard";

/**
 * As saídas do nó.
 *
 * MESSAGE com botões vira um card com uma linha por botão, cada uma com a sua
 * bolinha — é o que torna "qual caminho sai de qual botão" visível sem abrir
 * nada. Sem botões, é a saída única de sempre. CONDITION tem as duas saídas
 * fixas.
 */
function saidasDoNo(type: FlowNodeType, config: Record<string, unknown>): NodeCardHandle[] | undefined {
  if (type === "MESSAGE") {
    const botoes = (config as MessageNodeConfig).buttons ?? [];
    if (!botoes.length) return undefined;
    return botoes.map((b, i) => ({ id: `button:${i}`, label: b.label || `Opção ${i + 1}` }));
  }
  if (type === "CONDITION") {
    return [
      { id: "true", label: "Sim" },
      { id: "false", label: "Não" },
    ];
  }
  return undefined;
}

/**
 * Um componente só para todos os tipos de passo — o visual (ícone/cor) e o
 * resumo da configuração vêm de `NODE_VISUALS`/`describeNodeConfig`.
 * Registrado no `nodeTypes` do canvas sob cada chave, todas apontando pra cá.
 */
export function GenericFlowNode({ id, type, data, selected }: NodeProps<RFNode>) {
  const nodeType = type as FlowNodeType;
  const visual = NODE_VISUALS[nodeType];
  return (
    <NodeCard
      id={id}
      visual={visual}
      label={data.label || visual.defaultLabel}
      subtitle={describeNodeConfig(nodeType, data.config)}
      selected={selected}
      errors={data.errors}
      showTarget={nodeType !== "TRIGGER"}
      showSource={nodeType !== "END"}
      handles={saidasDoNo(nodeType, data.config)}
    />
  );
}
