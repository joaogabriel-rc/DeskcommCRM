import type { Node, Edge } from "@xyflow/react";
import type { FlowEdgeRow, FlowNodeRow, FlowNodeType } from "@/lib/flows/types";

export interface RFNodeData extends Record<string, unknown> {
  label: string;
  config: Record<string, unknown>;
  errors?: string[];
}

export type RFNode = Node<RFNodeData, FlowNodeType>;
export type RFEdge = Edge;

export function toReactFlow(nodes: FlowNodeRow[], edges: FlowEdgeRow[]): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.position_x, y: n.position_y },
      data: { label: n.label, config: n.config },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source_node_id,
      target: e.target_node_id,
      sourceHandle: e.source_handle,
    })),
  };
}

export function fromReactFlow(
  nodes: RFNode[],
  edges: RFEdge[],
): { nodes: FlowNodeRow[]; edges: FlowEdgeRow[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      flow_id: "",
      type: n.type as FlowNodeType,
      label: n.data.label,
      config: n.data.config,
      position_x: n.position.x,
      position_y: n.position.y,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      flow_id: "",
      source_node_id: e.source,
      target_node_id: e.target,
      source_handle: e.sourceHandle ?? null,
    })),
  };
}
