"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ConnectionLineType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Button } from "@/components/ui/button";
import { randomId } from "@/lib/random-id";
import { Plus, X } from "@/lib/ui/icons";
import { acaoPorTipo } from "@/lib/flows/acoes";
import type { FlowNodeType } from "@/lib/flows/types";
import { fromReactFlow, toReactFlow, type RFEdge, type RFNode } from "@/lib/flows/ui-mappers";
import { useFlow, useSaveFlowGraph } from "@/hooks/flows/useFlow";
import type { FlowDetailRow } from "@/hooks/flows/useFlow";
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
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(initial.edges);
  const { screenToFlowPosition } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isReadOnly = flow?.status === "active";

  const onNodeClick = useCallback<NodeMouseHandler<RFNode>>((_, node) => setSelectedNodeId(node.id), []);
  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const updateNodeData = useCallback(
    (id: string, patch: Partial<RFNode["data"]>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: RFEdge = {
        id: randomId(),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      };
      setEdges((eds) => addEdge(newEdge, eds));
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
      if (origem && !saidasNomeadas && origem.type !== "END") {
        setEdges((eds) =>
          addEdge({ id: randomId(), source: origem.id, target: id, sourceHandle: null, targetHandle: null }, eds),
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
    [screenToFlowPosition, setNodes],
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
      <div className="flex flex-1 overflow-hidden">
        <div className="relative h-full flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={isReadOnly ? undefined : onNodesChange}
            onEdgesChange={isReadOnly ? undefined : onEdgesChange}
            onConnect={isReadOnly ? undefined : onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodesDraggable={!isReadOnly}
            nodesConnectable={!isReadOnly}
            elementsSelectable
            defaultEdgeOptions={{ type: "smoothstep" }}
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
              <NodeConfigPanel
                key={selectedNode.id}
                node={selectedNode}
                onChange={(patch) => updateNodeData(selectedNode.id, patch)}
                onDelete={() => deleteNode(selectedNode.id)}
                onDuplicate={() => duplicarNo(selectedNode.id)}
              />
            </div>
          </aside>
        )}
      </div>

      <StepPicker open={pickerOpen} onOpenChange={setPickerOpen} onEscolher={adicionarPasso} />
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
