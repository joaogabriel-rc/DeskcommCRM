"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface OfficialChannelState {
  /**
   * O Cadastro Incorporado da Meta pode ser oferecido aqui? `faltando` nomeia o que
   * a instalação ainda não tem — a tela só mostra os nomes a quem administra a
   * instalação. Opcional: servidor anterior a esta versão não manda.
   */
  cadastroIncorporado?: {
    disponivel: boolean;
    faltando: string[];
    versaoDaGraph: string;
    configurarNaInstalacao: boolean;
  };
  /** Até quando a autorização gravada vale. `null` = não expira ou desconhecida. */
  tokenExpiraEm?: string | null;
  channel_session_id?: string | null;
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Base pública da API — usada no painel "Para integrar". */
  endpoint: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    /**
     * De onde vem o token que vale. `instalacao` = cadastrado na tela de
     * administração: existe, mas não volta num GET (foi mostrado uma vez, lá).
     * Opcional: ausente é lido como desconhecido, e a tela cai no aviso genérico.
     */
    verifyTokenOrigem?: "ambiente" | "instalacao" | null;
    /** Onde se cadastra o App da Meta — só para quem pode abrir a tela da instalação. */
    configurarEm?: string | null;
    fields: string[];
  } | null;
  /**
   * O que a instalação já fez SOZINHA com o webhook deste número (fatia F1 da #850):
   * a Meta foi apontada para o endereço desta sessão, ou ainda não.
   *
   * `registrado: false` NÃO é canal quebrado: ele envia normalmente; o que depende
   * disto é a ENTREGA. Nulo = banco sem a migration 0311 (a tela volta ao passo
   * manual, que é o estado anterior — e continua verdadeiro).
   */
  webhookRegistro: {
    registrado: boolean;
    url: string | null;
    erro: string | null;
    em: string | null;
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
}

export interface ConclusaoDoCadastro {
  state: string;
  code: string;
  evento?: string;
  sugestao?: { waba_id?: string; phone_number_id?: string };
}

export interface CanalConectadoPeloCadastro {
  connected: boolean;
  displayName: string;
  phoneNumber: string | null;
  tokenExpiraEm: string | null;
  webhookRegistro: { registrado: boolean; url: string | null; erro: string | null; em: string } | null;
}

export interface RegistroDoWebhook {
  registrado: boolean;
  url: string | null;
  erro: string | null;
  em: string;
  callbackUrl: string;
}

export function useOfficialChannel() {
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

/**
 * "Tentar de novo" o registro do webhook — sem pedir a credencial outra vez.
 *
 * A rota responde 200 mesmo quando a Meta recusa (o motivo vem em `erro`), e é de
 * propósito: aqui o que interessa é o MOTIVO na tela. Por isso não há toast de erro
 * genérico no sucesso — a invalidação recarrega o estado e o aviso âmbar com o motivo
 * fica onde o operador pode lê-lo, em vez de desaparecer em três segundos.
 */
export function useRegistrarWebhookOficial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: RegistroDoWebhook }>("/api/v1/channels/official/webhook", {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

/**
 * Emite o `state` do Cadastro Incorporado. Chamado ANTES do clique: o popup da
 * Meta só abre se o clique chamar o SDK sem esperar nada. Função simples e não
 * mutação do react-query: não há cache a invalidar, e quem chama controla o
 * próprio estado de "preparando".
 */
export function pedirEstadoDoCadastroIncorporado() {
  return apiClient.post<{ data: { state: string; expira_em: string } }>(
    "/api/v1/channels/official/cadastro/iniciar",
    {},
  );
}

/**
 * Entrega o authorization code ao servidor. Sem `onError` genérico: a recusa traz
 * uma frase acionável (code expirado, conta sem número...) e quem a mostra é a tela.
 */
export function useConcluirCadastroIncorporado() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConclusaoDoCadastro) =>
      apiClient.post<{ data: CanalConectadoPeloCadastro }>(
        "/api/v1/channels/official/cadastro/concluir",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}
