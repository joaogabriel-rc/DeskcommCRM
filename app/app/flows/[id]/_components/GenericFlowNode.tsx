"use client";

import type { NodeProps } from "@xyflow/react";

import { acharModeloNoCatalogo, useCatalogoDeModelos } from "@/hooks/channels/useCatalogoDeModelos";
import { useT } from "@/lib/i18n/IdiomaProvider";
import type { FlowNodeType, MessageNodeConfig, TriggerNodeConfig } from "@/lib/flows/types";
import type { RFNode } from "@/lib/flows/ui-mappers";
import { describeNodeConfig, NODE_VISUALS } from "./nodeVisuals";
import { NodeCard, type NodeCardHandle } from "./NodeCard";
import { PreviaDoModelo } from "./PreviaDoModelo";

/**
 * As saídas do nó.
 *
 * MESSAGE com botões vira um card com uma linha por botão, cada uma com a sua
 * bolinha — é o que torna "qual caminho sai de qual botão" visível sem abrir
 * nada. Com modelo aprovado escolhido, os botões SÃO as respostas rápidas do
 * modelo (gravadas em `buttons` na escolha), então a mesma regra vale. Sem
 * botões, é a saída única de sempre. CONDITION tem as duas saídas fixas.
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
 * O modelo escolhido, dentro do card — o conteúdo vem do CATÁLOGO (o nó só
 * guarda a referência). A consulta é a mesma de todos os cards e do painel: o
 * react-query a faz uma vez só.
 */
function ModeloNoCard({ config }: { config: MessageNodeConfig }) {
  const t = useT();
  const catalogo = useCatalogoDeModelos({ todos: true });
  if (!config.template_name && !config.template_id) {
    return (
      <p className="rounded-md border border-dashed border-border px-2 py-2 text-center text-xs text-text-muted">
        {t("Escolher modelo de mensagem")}
      </p>
    );
  }
  if (!catalogo.data) return null;
  const modelo = acharModeloNoCatalogo(catalogo.data, config);
  if (!modelo) {
    return (
      <p className="rounded-md bg-warning-bg px-2 py-1 text-xs text-warning-fg" data-testid="modelo-nao-localizado">
        {t("Modelo não localizado no catálogo")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {!modelo.utilizavel && (
        <p className="rounded-md bg-error-bg px-2 py-1 text-xs text-error-fg">
          {t("Modelo não aprovado")} ({modelo.status})
        </p>
      )}
      <PreviaDoModelo modelo={modelo} compacta />
    </div>
  );
}

/**
 * Um componente só para todos os tipos de passo — o visual (ícone/cor) e o
 * resumo da configuração vêm de `NODE_VISUALS`/`describeNodeConfig`.
 * Registrado no `nodeTypes` do canvas sob cada chave, todas apontando pra cá.
 */
export function GenericFlowNode({ id, type, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const nodeType = type as FlowNodeType;
  const visual = NODE_VISUALS[nodeType];
  const messageConfig = data.config as MessageNodeConfig;
  const semGatilho = nodeType === "TRIGGER" && !(data.config as TriggerNodeConfig).trigger_type;

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
    >
      {semGatilho && (
        <p
          className="rounded-md border border-dashed border-accent-400 px-2 py-2 text-center text-xs text-accent"
          data-testid="card-novo-gatilho"
        >
          + {t("Novo gatilho")}
        </p>
      )}
      {nodeType === "MESSAGE" && messageConfig.window_mode === "outside_24h" && <ModeloNoCard config={messageConfig} />}
    </NodeCard>
  );
}
