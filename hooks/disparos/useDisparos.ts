"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type {
  AcaoDeDisparo,
  CriarDisparoInput,
  DisparoRow,
  MensagemDeDisparo,
  Segmento,
} from "@/lib/schemas/disparos";

export const disparosQueryKey = ["disparos", "list"] as const;
export function disparoQueryKey(id: string) {
  return ["disparos", "detail", id] as const;
}

/** Um destinatário que não recebeu, com o motivo — o que a tela mostra no fim. */
export interface ProblemaDoDisparo {
  id: string;
  status: "failed" | "skipped";
  error: string | null;
  sent_at: string | null;
  contacts: { id: string; name: string | null; display_name: string | null; phone_number: string | null } | null;
}

export interface DisparoDetalhe extends DisparoRow {
  problemas: ProblemaDoDisparo[];
}

export function useDisparos(opts?: { initialData?: DisparoRow[] }) {
  return useQuery({
    queryKey: disparosQueryKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: DisparoRow[] }>("/api/v1/broadcasts");
      return res.data;
    },
    initialData: opts?.initialData,
  });
}

export function useDisparo(id: string, opts?: { initialData?: DisparoDetalhe; emAndamento?: boolean }) {
  return useQuery({
    queryKey: disparoQueryKey(id),
    queryFn: async () => {
      const res = await apiClient.get<{ data: DisparoDetalhe }>(`/api/v1/broadcasts/${id}`);
      return res.data;
    },
    initialData: opts?.initialData,
    // Enquanto o worker está mandando, a tela precisa andar sozinha: o número
    // que não sobe lê como "travou". Fora disso não há o que buscar.
    refetchInterval: opts?.emAndamento ? 5000 : false,
  });
}

export function useCriarDisparo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarDisparoInput) => {
      const res = await apiClient.post<{ data: DisparoRow }>("/api/v1/broadcasts", input);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: disparosQueryKey }),
    onError: (err) => showApiError(err),
  });
}

export function useSalvarDisparo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name?: string;
      segment?: Segmento;
      message?: MensagemDeDisparo;
      scheduled_at?: string | null;
    }) => {
      const res = await apiClient.patch<{ data: DisparoRow }>(`/api/v1/broadcasts/${id}`, input);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: disparoQueryKey(id) });
      qc.invalidateQueries({ queryKey: disparosQueryKey });
      toast.success("Disparo salvo.");
    },
    onError: (err) => showApiError(err),
  });
}

const RECADO: Record<AcaoDeDisparo, string> = {
  agendar: "Disparo agendado. O envio começa no horário escolhido, no ritmo anti-banimento.",
  pausar: "Disparo pausado. Quem ainda não recebeu continua na fila.",
  retomar: "Disparo retomado.",
  cancelar: "Disparo cancelado. Quem ainda não recebeu não vai receber.",
};

export function useAcaoDeDisparo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (acao: AcaoDeDisparo) => {
      const res = await apiClient.patch<{ data: DisparoRow }>(`/api/v1/broadcasts/${id}`, { acao });
      return { acao, disparo: res.data };
    },
    onSuccess: ({ acao }) => {
      qc.invalidateQueries({ queryKey: disparoQueryKey(id) });
      qc.invalidateQueries({ queryKey: disparosQueryKey });
      toast.success(RECADO[acao]);
    },
    onError: (err) => showApiError(err),
  });
}

export function useExcluirDisparo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/api/v1/broadcasts/${id}`);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: disparosQueryKey });
      toast.success("Disparo excluído.");
    },
    onError: (err) => showApiError(err),
  });
}

/**
 * A PRÉVIA do público. Chamada a cada mudança de critério, com `enabled` para
 * não bater no servidor enquanto o construtor está vazio.
 *
 * A mesma função de segmentação que o agendamento usa responde aqui — é por
 * isso que o número da prévia é o número que vai sair.
 */
export function usePreviaDePublico(segmento: Segmento, habilitado: boolean) {
  return useQuery({
    queryKey: ["disparos", "previa", segmento] as const,
    queryFn: async () => {
      // Listas repetem o parâmetro; cada critério de campo vira
      // `campo=<chave>:<operador>:<valor>`. Ver o cabeçalho da rota para o
      // porquê de a prévia ser um GET e não um verbo mutante.
      const q = new URLSearchParams();
      for (const t of segmento.tags_all) q.append("tag_all", t);
      for (const t of segmento.tags_any) q.append("tag_any", t);
      for (const t of segmento.tags_none) q.append("tag_none", t);
      for (const f of segmento.fields) q.append("campo", `${f.key}:${f.op}:${f.value}`);
      const res = await apiClient.get<{ data: { total: number; resumo: string } }>(
        `/api/v1/broadcasts/previa?${q.toString()}`,
      );
      return res.data;
    },
    enabled: habilitado,
    staleTime: 15_000,
  });
}
