"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AvisoDeFluxoProtegido } from "@/components/disparos/AvisoDeFluxoProtegido";
import { Button } from "@/components/ui/button";
import { randomId } from "@/lib/random-id";
import { Plus, X } from "@/lib/ui/icons";
import { acaoPorTipo } from "@/lib/flows/acoes";
import { conectarSaida, podarArestasDeBotaoOrfas, saidaLivre } from "@/lib/flows/arestas";
import type { FlowNodeType } from "@/lib/flows/types";
import { canvasSomenteLeitura } from "@/lib/flows/uso";
import { fromReactFlow, toReactFlow, type RFEdge, type RFNode } from "@/lib/flows/ui-mappers";
import { useFlow, useSaveFlowGraph } from "@/hooks/flows/useFlow";
import type { FlowDetailRow } from "@/hooks/flows/useFlow";
import { ArestaRemovivel } from "./ArestaRemovivel";
import { GenericFlowNode } from "./GenericFlowNode";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { NODE_VISUALS } from "./nodeVisuals";
import { PublishBar } from "./PublishBar";
import { StepPicker, type EscolhaDePasso } from "./StepPicker";

const nodeTypes: NodeTypes = {
  TRIGGER: GenericFlowNode,
  MESSAGE: GenericFlowNode,
  CONDITION: GenericFlowNode,
  ACTION: GenericFlowNode,
  DELAY: GenericFlowNode,
  WEBHOOK: GenericFlowNode,
  END: GenericFlowNode,
};

/** Toda linha do canvas é selecionável e apagável (ver `ArestaRemovivel`). */
const TIPO_DA_ARESTA = "removivel";
const edgeTypes: EdgeTypes = { [TIPO_DA_ARESTA]: ArestaRemovivel };

interface Props {
  flowId: string;
  initialData: FlowDetailRow;
}

function FlowCanvasInner({ flowId, initialData }: Props) {
  const { data: flow } = useFlow(flowId, { initialData });
  const saveGraph = useSaveFlowGraph(flowId);
  const initial = useMemo(
    () => toReactFlow(initialData.nodes, initialData.edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(
    initial.edges.map((e) => ({ ...e, type: TIPO_DA_ARESTA })),
  );
  const { screenToFlowPosition } = useReactFlow();
  // Rascunho recém-criado abre com o "Quando…" SELECIONADO: o painel dele
  // aparece com o seletor de gatilho aberto, que é a primeira decisão do fluxo.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => {
    const gatilho = initial.nodes.find((n) => n.type === "TRIGGER");
    return gatilho && !(gatilho.data.config as { trigger_type?: unknown }).trigger_type ? gatilho.id : null;
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  // Disparo: a regra do banco (migration 0507) — histórico ou em uso não se
  // edita. Automações: `active` trava, como sempre.
  const isReadOnly = canvasSomenteLeitura(flow, flow?.uso);

  const onNodeClick = useCallback<NodeMouseHandler<RFNode>>((_, node) => setSelectedNodeId(node.id), []);
  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const updateNodeData = useCallback(
    (id: string, patch: Partial<RFNode["data"]>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  // Botão removido ou trocado para "Abrir site" deixa de ser saída: a aresta
  // dele sai do ESTADO (não só do desenho), para não ser gravada invisível nem
  // reaparecer quando o botão voltar a ser de fluxo.
  useEffect(() => {
    setEdges((eds) => podarArestasDeBotaoOrfas(nodes, eds));
  }, [nodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: RFEdge = {
        id: randomId(),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: TIPO_DA_ARESTA,
      };
      // Uma saída, um destino: ligar numa saída ocupada troca o destino.
      setEdges((eds) => conectarSaida(eds, newEdge));
    },
    [setEdges],
  );

  /**
   * Passo novo já nasce LIGADO ao nó selecionado (ou ao último, se nenhum
   * estiver selecionado): o gesto do "+" é "e depois?", então deixar o nó solto
   * no canvas obrigaria a arrastar a conexão toda vez.
   */
  const adicionarPasso = useCallback(
    (escolha: EscolhaDePasso) => {
      const visual = NODE_VISUALS[escolha.type];
      const origem = nodes.find((n) => n.id === selectedNodeId) ?? nodes[nodes.length - 1] ?? null;
      const id = randomId();
      const config = visual.defaultConfig();
      if (escolha.type === "ACTION" && escolha.actionType) {
        config.action_type = escolha.actionType;
        config.config = {};
      }
      const rotulo =
        escolha.type === "ACTION" && escolha.actionType
          ? (acaoPorTipo(escolha.actionType)?.label ?? visual.defaultLabel)
          : visual.defaultLabel;
      const novo: RFNode = {
        id,
        type: escolha.type,
        position: origem
          ? { x: origem.position.x + 300, y: origem.position.y }
          : { x: 360, y: 120 },
        data: { label: rotulo, config },
      };
      setNodes((nds) => nds.concat(novo));
      // Só liga sozinho quando a origem tem UMA saída: num nó de botões ou de
      // condição, qual das saídas seria a certa é escolha de quem monta.
      const saidasNomeadas =
        origem &&
        (origem.type === "CONDITION" ||
          (origem.type === "MESSAGE" &&
            Array.isArray((origem.data.config as { buttons?: unknown[] }).buttons) &&
            ((origem.data.config as { buttons?: unknown[] }).buttons?.length ?? 0) > 0));
      // E só liga numa saída LIVRE: se o operador já ligou (ou desligou de
      // propósito e religou) a saída padrão, o "+" não passa por cima.
      if (origem && !saidasNomeadas && origem.type !== "END") {
        setEdges((eds) =>
          saidaLivre(eds, origem.id, null)
            ? eds.concat({
                id: randomId(),
                source: origem.id,
                target: id,
                sourceHandle: null,
                targetHandle: null,
                type: TIPO_DA_ARESTA,
              })
            : eds,
        );
      }
      setSelectedNodeId(id);
    },
    [nodes, selectedNodeId, setNodes, setEdges],
  );

  const duplicarNo = useCallback(
    (id: string) => {
      const original = nodes.find((n) => n.id === id);
      if (!original || original.type === "TRIGGER") return;
      const copia: RFNode = {
        id: randomId(),
        type: original.type,
        position: { x: original.position.x + 40, y: original.position.y + 80 },
        data: {
          label: `${original.data.label} (cópia)`,
          config: JSON.parse(JSON.stringify(original.data.config)) as Record<string, unknown>,
        },
      };
      setNodes((nds) => nds.concat(copia));
      setSelectedNodeId(copia.id);
    },
    [nodes, setNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelectedNodeId((cur) => (cur === id ? null : cur));
    },
    [setNodes, setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (isReadOnly) return;
      const type = e.dataTransfer.getData("application/x-flow-node-type") as FlowNodeType | "";
      if (!type) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const visual = NODE_VISUALS[type];
      setNodes((nds) =>
        nds.concat({
          id: randomId(),
          type,
          position,
          data: { label: visual.defaultLabel, config: visual.defaultConfig() },
        }),
      );
    },
    [screenToFlowPosition, setNodes, isReadOnly],
  );

  const onSave = useCallback(() => {
    const graph = fromReactFlow(nodes, edges);
    saveGraph.mutate({
      nodes: graph.nodes.map((n) => ({ ...n, flow_id: flowId })),
      edges: graph.edges.map((e) => ({ ...e, flow_id: flowId })),
    });
  }, [nodes, edges, saveGraph, flowId]);

  return (
    <div className="flex h-full min-h-[600px] w-full flex-col">
      {flow && <PublishBar flowId={flowId} flow={flow} onSave={onSave} saving={saveGraph.isPending} />}
      {flow?.broadcast_id && (
        <AvisoDeFluxoProtegido uso={flow.uso} broadcastId={flow.broadcast_id} className="mx-3 mt-3" />
      )}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative h-full flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={isReadOnly ? undefined : onNodesChange}
            onEdgesChange={isReadOnly ? undefined : onEdgesChange}
            onConnect={isReadOnly ? undefined : onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodesDraggable={!isReadOnly}
            nodesConnectable={!isReadOnly}
            elementsSelectable
            deleteKeyCode={isReadOnly ? null : ["Backspace", "Delete"]}
            defaultEdgeOptions={{ type: TIPO_DA_ARESTA }}
            connectionLineType={ConnectionLineType.SmoothStep}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>

          {!isReadOnly && (
            <Button
              type="button"
              size="icon"
              className="absolute right-6 top-6 z-10 h-12 w-12 rounded-full shadow-lg"
              onClick={() => setPickerOpen(true)}
              aria-label="Adicionar passo"
              data-testid="flow-add-step"
            >
              <Plus size={20} aria-hidden />
            </Button>
          )}
        </div>

        {selectedNode && (
          <aside
            className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col overflow-hidden rounded-t-lg border-t border-border bg-surface shadow-lg lg:static lg:z-auto lg:h-full lg:w-96 lg:max-h-none lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
            data-testid="node-config-sheet"
          >
            <div className="flex shrink-0 justify-end p-2 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelectedNodeId(null)}
                aria-label="Fechar"
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-0 lg:pt-4">
              {/* Somente leitura: o painel continua mostrando a configuração —
                  é o histórico que a pessoa veio ver — mas nenhum campo, botão
                  de excluir ou de duplicar responde. */}
              <fieldset disabled={isReadOnly} data-testid="painel-somente-leitura" data-somente-leitura={isReadOnly}>
                <NodeConfigPanel
                  key={selectedNode.id}
                  flowId={flowId}
                  node={selectedNode}
                  onChange={(patch) => (isReadOnly ? undefined : updateNodeData(selectedNode.id, patch))}
                  onDelete={() => (isReadOnly ? undefined : deleteNode(selectedNode.id))}
                  onDuplicate={() => (isReadOnly ? undefined : duplicarNo(selectedNode.id))}
                />
              </fieldset>
            </div>
          </aside>
        )}
      </div>

      <StepPicker open={pickerOpen && !isReadOnly} onOpenChange={setPickerOpen} onEscolher={adicionarPasso} />
    </div>
  );
}

export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
