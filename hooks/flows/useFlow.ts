"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { FlowNodeRow, FlowEdgeRow } from "@/lib/flows/types";
import type { FlowRow } from "./useFlows";

export interface FlowDetailRow extends FlowRow {
  nodes: FlowNodeRow[];
  edges: FlowEdgeRow[];
}

export function flowQueryKey(id: string) {
  return ["flows", "detail", id] as const;
}

export function useFlow(id: string, opts?: { initialData?: FlowDetailRow }) {
  return useQuery({
    queryKey: flowQueryKey(id),
    queryFn: async () => {
      const res = await apiClient.get<{ data: FlowDetailRow }>(`/api/v1/flows/${id}`);
      return res.data;
    },
    initialData: opts?.initialData,
  });
}

export function useSaveFlowGraph(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (graph: { nodes: FlowNodeRow[]; edges: FlowEdgeRow[] }) => {
      await apiClient.put(`/api/v1/flows/${id}/graph`, graph);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flowQueryKey(id) });
      toast.success("Flow salvo.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useUpdateFlowStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (status: "draft" | "active" | "archived") => {
      const res = await apiClient.patch<{ data: FlowRow }>(`/api/v1/flows/${id}`, { status });
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FlowDetailRow>(flowQueryKey(id), (prev) => (prev ? { ...prev, ...updated } : prev));
      qc.invalidateQueries({ queryKey: ["flows", "list"] });
      toast.success(updated.status === "active" ? "Flow ativado." : "Flow pausado.");
    },
    onError: (err) => showApiError(err),
  });
}

/**
 * Renomear o fluxo pelo cabeçalho do construtor. O fluxo nasce "Sem título"
 * (ele abre direto no canvas), então o nome precisa ser editável ali mesmo —
 * sem voltar à lista. Mesma rota do PATCH de status, só com `name`.
 */
export function useRenameFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.patch<{ data: FlowRow }>(`/api/v1/flows/${id}`, { name });
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FlowDetailRow>(flowQueryKey(id), (prev) => (prev ? { ...prev, ...updated } : prev));
      qc.invalidateQueries({ queryKey: ["flows", "list"] });
    },
    onError: (err) => showApiError(err),
  });
}

export interface FlowExecutionListItem {
  id: string;
  status: string;
  waiting_for: string | null;
  current_node_id: string | null;
  last_error: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  contacts: { id: string; name: string | null; display_name: string | null; phone_number: string | null } | null;
}

export function useFlowExecutions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["flows", "detail", id, "executions"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: FlowExecutionListItem[] }>(`/api/v1/flows/${id}/executions`);
      return res.data;
    },
    enabled,
  });
}
