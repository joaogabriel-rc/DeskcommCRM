"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { FlowTriggerId } from "@/lib/flows/triggers";

export interface FlowRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: FlowTriggerId;
  /** Livre por gatilho: tag, campo, etapa, palavra-chave. Ver lib/flows/triggers.ts. */
  trigger_config: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export const flowsListQueryKey = ["flows", "list"] as const;

export function useFlows(opts?: { initialData?: FlowRow[] }) {
  return useQuery({
    queryKey: flowsListQueryKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: FlowRow[] }>("/api/v1/flows");
      return res.data;
    },
    initialData: opts?.initialData,
  });
}

export function useCreateFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string;
      trigger_type: FlowTriggerId;
      trigger_config: Record<string, unknown>;
    }) => {
      const res = await apiClient.post<{ data: FlowRow }>("/api/v1/flows", input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flowsListQueryKey });
    },
    onError: (err) => showApiError(err),
  });
}

export function useDeleteFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/api/v1/flows/${id}`);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flowsListQueryKey });
      toast.success("Flow excluído.");
    },
    onError: (err) => showApiError(err),
  });
}
