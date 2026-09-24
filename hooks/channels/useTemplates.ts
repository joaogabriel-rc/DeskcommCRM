"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface TemplateSlotView {
  key: string;
  expects: string;
  /** Rótulo humano do endereço: "corpo", "cabeçalho", "card 2 › cabeçalho". */
  onde: string;
}

/** Texto de um componente, inteiro e uma vez só — a UI marca os `{{n}}`. */
export interface TemplatePreview {
  onde: string;
  text: string;
}

export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  /** DERIVADOS do template pela API — nunca digitados, nunca contados à mão. */
  slots: TemplateSlotView[];
  previews: TemplatePreview[];
}

/** Uma conexão oficial em que se pode criar modelo. */
export interface ConexaoOficial {
  id: string;
  rotulo: string;
  wabaId: string | null;
}

export interface TemplatesPayload {
  /** `null` = canal oficial não conectado. Distinto de "conectado e sem template". */
  waba: string | null;
  /** As conexões oficiais ativas — onde "Criar modelo" pode criar. */
  conexoes?: ConexaoOficial[];
  templates: TemplateView[];
}

export interface SyncCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  disabled: number;
}

export function useTemplates() {
  return useQuery({
    queryKey: ["channel-templates"],
    queryFn: async () => apiClient.get<{ data: TemplatesPayload }>("/api/v1/channels/templates"),
    staleTime: 30_000,
  });
}

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.post<{ data: SyncCounts }>("/api/v1/channels/templates", {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
    },
  });
}

/** O rascunho que o formulário monta, com a conexão em que será criado. */
export interface PedidoDeModelo {
  channel_session_id: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

/**
 * Cria o modelo na Meta, pela conta da conexão escolhida. Ele volta PENDENTE:
 * quem aprova é a Meta, e até lá ele não aparece como utilizável em Fluxos nem
 * em Disparos.
 */
export function useCriarModelo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pedido: PedidoDeModelo) =>
      apiClient.post<{ data: { modelo: { name: string; status: string }; provider_template_id: string } }>(
        "/api/v1/channels/templates",
        { acao: "criar", ...pedido },
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
      // O catálogo central (Fluxos, Disparos) também passa a vê-lo — pendente.
      qc.invalidateQueries({ queryKey: ["channel-template-catalog"] });
    },
  });
}
