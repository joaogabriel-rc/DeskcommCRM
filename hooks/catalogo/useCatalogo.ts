"use client";
/**
 * Os dois REGISTROS que toda a automação consulta: etiquetas e campos do
 * contato (migration 0312).
 *
 * Um arquivo para os dois de propósito. Eles são a mesma ideia — "o que esta
 * organização declarou que existe" — e são consumidos SEMPRE juntos: o painel
 * do nó ACTION precisa dos dois, o construtor de segmento dos disparos precisa
 * dos dois, e o editor de mensagem precisa dos campos para oferecer variável.
 * Dois arquivos significariam dois `queryKey` que alguém esqueceria de
 * invalidar junto.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { AtualizarCampoInput, CampoDoContato, CriarCampoInput } from "@/lib/schemas/contact-fields";
import type { AtualizarTagInput, CriarTagInput, TagDoRegistro } from "@/lib/schemas/tags";

export const tagsQueryKey = ["catalogo", "tags"] as const;
export const camposQueryKey = ["catalogo", "campos"] as const;

/* ── Etiquetas ─────────────────────────────────────────────────────────────── */

export function useTags(opts?: { incluirArquivadas?: boolean; initialData?: TagDoRegistro[] }) {
  const arquivadas = opts?.incluirArquivadas ?? false;
  return useQuery({
    queryKey: [...tagsQueryKey, arquivadas] as const,
    queryFn: async () => {
      const res = await apiClient.get<{ data: TagDoRegistro[] }>(
        `/api/v1/tags${arquivadas ? "?arquivadas=1" : ""}`,
      );
      return res.data;
    },
    initialData: arquivadas ? undefined : opts?.initialData,
  });
}

export function useCriarTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarTagInput) => {
      const res = await apiClient.post<{ data: TagDoRegistro }>("/api/v1/tags", input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tagsQueryKey });
      toast.success("Tag criada.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useAtualizarTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: AtualizarTagInput & { id: string }) => {
      const res = await apiClient.patch<{ data: TagDoRegistro }>(`/api/v1/tags/${id}`, input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tagsQueryKey });
      // A renomeação reescreve `contacts.tags`, `crm_leads.tags` e
      // `conversations.tags` — o vocabulário derivado que a tela de Tags mostra
      // ao lado sai daí, e ficaria com o nome velho sem esta linha.
      qc.invalidateQueries({ queryKey: ["tags", "vocabulario"] });
      toast.success("Tag atualizada.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useExcluirTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/api/v1/tags/${id}`);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tagsQueryKey });
      toast.success("Tag removida do vocabulário.");
    },
    onError: (err) => showApiError(err),
  });
}

/* ── Campos do contato ─────────────────────────────────────────────────────── */

export function useCamposDoContato(opts?: {
  incluirArquivados?: boolean;
  initialData?: CampoDoContato[];
}) {
  const arquivados = opts?.incluirArquivados ?? false;
  return useQuery({
    queryKey: [...camposQueryKey, arquivados] as const,
    queryFn: async () => {
      const res = await apiClient.get<{ data: CampoDoContato[] }>(
        `/api/v1/contact-fields${arquivados ? "?arquivados=1" : ""}`,
      );
      return res.data;
    },
    initialData: arquivados ? undefined : opts?.initialData,
  });
}

export function useCriarCampo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarCampoInput) => {
      const res = await apiClient.post<{ data: CampoDoContato }>("/api/v1/contact-fields", input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: camposQueryKey });
      toast.success("Campo criado.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useAtualizarCampo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: AtualizarCampoInput & { id: string }) => {
      const res = await apiClient.patch<{ data: CampoDoContato }>(`/api/v1/contact-fields/${id}`, input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: camposQueryKey });
      toast.success("Campo atualizado.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useExcluirCampo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/api/v1/contact-fields/${id}`);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: camposQueryKey });
      toast.success("Campo excluído do registro. Os valores já gravados nos contatos continuam lá.");
    },
    onError: (err) => showApiError(err),
  });
}
