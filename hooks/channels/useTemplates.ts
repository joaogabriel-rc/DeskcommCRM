"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface TemplateSlotView {
  key: string;
  expects: string;
  /** Rótulo humano do endereço: "corpo", "cabeçalho", "card 2 › cabeçalho". */
  onde: string;
  /** A chave deste valor em `template_values` e em `savedValues` (`header:1`). */
  valueKey: string;
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
  /** Links de mídia salvos no modelo — o painel da janela fechada pré-preenche com eles. */
  savedValues: Record<string, string>;
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

/**
 * As listas que leem o espelho de modelos: a da tela de Conexões, o catálogo
 * central (Fluxos e Disparos — que também leem os links salvos) e o painel da
 * janela fechada na conversa. Quem escreve no espelho invalida as três, senão
 * uma delas mostra o estado velho até o `staleTime`.
 */
function invalidarListasDeModelos(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ["channel-templates"] });
  qc.invalidateQueries({ queryKey: ["channel-template-catalog"] });
  qc.invalidateQueries({ queryKey: ["templates-da-conversa"] });
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
    onSuccess: () => invalidarListasDeModelos(qc),
  });
}

/**
 * Grava (ou esquece, com string vazia) o link de mídia do modelo. Invalida
 * também a lista do painel da janela fechada, que lê a mesma rota com outra
 * chave: sem isso o link salvo aqui só apareceria na conversa depois do
 * `staleTime`.
 */
export function useSaveTemplateValues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { name: string; language: string; values: Record<string, string> }) =>
      apiClient.patch<{ data: { savedValues: Record<string, string> } }>(
        "/api/v1/channels/templates",
        args,
      ),
    onError: showApiError,
    onSuccess: () => invalidarListasDeModelos(qc),
  });
}
