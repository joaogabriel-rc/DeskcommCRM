/**
 * A tela do Cadastro Incorporado da Meta, dirigida como quem usa: o botão, o
 * popup (SDK falso) e a conclusão — e o formulário manual, que continua sendo o
 * caminho quando a instalação não tem o app da Meta configurado.
 *
 * O caso que só um teste de tela pega: `FB.login` tem de sair SÍNCRONO dentro do
 * clique. Com qualquer `await` antes, o navegador bloqueia o popup — e nenhum
 * teste de rota veria isso.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const pedirEstado = vi.fn();
const concluir = vi.fn();
let estadoDoCanal: Record<string, unknown>;

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  pedirEstadoDoCadastroIncorporado: () => pedirEstado(),
  useConcluirCadastroIncorporado: () => ({ mutateAsync: concluir }),
  useOfficialChannel: () => ({ data: { data: estadoDoCanal }, isPending: false }),
  useConnectOfficialChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarWebhookOficial: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BotaoCadastroIncorporado } from "@/components/connections/BotaoCadastroIncorporado";
import { CanalOficialClient } from "@/components/connections/CanalOficialClient";

const login = vi.fn();
let callbackDoLogin: ((r: unknown) => void) | null;

function mensagemDaMeta(origem: string, event: string, data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", { origin: origem, data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data }) }),
  );
}

function botao(props: Partial<Parameters<typeof BotaoCadastroIncorporado>[0]> = {}) {
  return render(
    <BotaoCadastroIncorporado
      disponivel
      faltando={[]}
      versaoDaGraph="v22.0"
      configurarNaInstalacao={false}
      jaConectado={false}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  callbackDoLogin = null;
  login.mockImplementation((cb: (r: unknown) => void) => {
    callbackDoLogin = cb;
  });
  window.FB = { init: vi.fn(), login };
  window.__PUBLIC_ENV__ = { META_APP_ID: "1111122222", META_EMBEDDED_SIGNUP_CONFIG_ID: "3333344444" };
  pedirEstado.mockResolvedValue({
    data: { state: "state-assinado", expira_em: new Date(Date.now() + 15 * 60_000).toISOString() },
  });
  concluir.mockResolvedValue({
    data: { connected: true, displayName: "Loja Teste", phoneNumber: "+5531900000000", tokenExpiraEm: null, webhookRegistro: null },
  });
  estadoDoCanal = { connected: false, hasToken: false, webhook: null, webhookRegistro: null };
});

afterEach(() => {
  delete window.__PUBLIC_ENV__;
});

async function botaoPronto() {
  const b = await screen.findByTestId("btn-cadastro-meta");
  await waitFor(() => expect(b).not.toBeDisabled());
  expect(b).toHaveTextContent("Conectar WhatsApp com Meta");
  return b;
}

describe("botão Conectar WhatsApp com Meta", () => {
  it("abre o fluxo v4 SÍNCRONO no clique e conclui com o code, o state e a sugestão da Meta", async () => {
    botao();
    const b = await botaoPronto();

    fireEvent.click(b);
    // Síncrono: nenhum await entre o clique e esta linha.
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]![1]).toEqual({
      config_id: "3333344444",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    });
    expect(b).toHaveTextContent("Aguardando a Meta…");

    act(() => {
      mensagemDaMeta("https://www.facebook.com", "FINISH", {
        waba_id: "200000000000001",
        phone_number_id: "100000000000001",
      });
      callbackDoLogin!({ status: "connected", authResponse: { code: "CODE-DA-META" } });
    });

    await waitFor(() => expect(concluir).toHaveBeenCalledTimes(1));
    expect(concluir).toHaveBeenCalledWith({
      state: "state-assinado",
      code: "CODE-DA-META",
      evento: "FINISH",
      sugestao: { waba_id: "200000000000001", phone_number_id: "100000000000001" },
    });
    expect(await screen.findByText(/Loja Teste/)).toBeInTheDocument();
    expect(screen.getByTestId("cadastro-meta-estado")).toHaveAttribute("data-fase", "sucesso");
    // O state foi gasto: um novo é pedido para a próxima tentativa.
    await waitFor(() => expect(pedirEstado).toHaveBeenCalledTimes(2));
  });

  it("ignora mensagem de origem falsa — o code segue sem sugestão, e o servidor descobre", async () => {
    botao();
    fireEvent.click(await botaoPronto());
    act(() => {
      mensagemDaMeta("https://evilfacebook.com", "FINISH", { waba_id: "299999999999999" });
      callbackDoLogin!({ authResponse: { code: "CODE" } });
    });
    await waitFor(() => expect(concluir).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(concluir.mock.calls[0]![0]).toMatchObject({ code: "CODE", evento: undefined, sugestao: undefined });
  });

  it("popup fechado sem autorizar é cancelamento, e nada vai ao servidor", async () => {
    botao();
    fireEvent.click(await botaoPronto());
    act(() => {
      mensagemDaMeta("https://www.facebook.com", "CANCEL", { current_step: "PHONE_NUMBER_SETUP" });
      callbackDoLogin!({ status: "unknown", authResponse: null });
    });
    expect(await screen.findByText(/cancelada antes de terminar/)).toBeInTheDocument();
    expect(concluir).not.toHaveBeenCalled();
  });

  it("erro do fluxo (CANCEL com error_message) aparece como erro, não como desistência", async () => {
    botao();
    fireEvent.click(await botaoPronto());
    act(() => {
      mensagemDaMeta("https://www.facebook.com", "CANCEL", { error_message: "x", error_code: "1" });
      callbackDoLogin!({ authResponse: null });
    });
    expect(await screen.findByText(/interrompeu a conexão com um erro/)).toBeInTheDocument();
  });

  it("recusa do servidor mostra a frase acionável que ele mandou", async () => {
    concluir.mockRejectedValue(
      new ApiError(422, "invalid_request", { motivo: "numero_nao_encontrado" }, "rid", "A conta do WhatsApp Business não tem número."),
    );
    botao();
    fireEvent.click(await botaoPronto());
    act(() => callbackDoLogin!({ authResponse: { code: "CODE" } }));
    expect(await screen.findByText("A conta do WhatsApp Business não tem número.", {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("indisponível: quem administra a instalação vê o que falta; os demais, a quem pedir", () => {
    const { rerender } = botao({ disponivel: false, faltando: ["META_EMBEDDED_SIGNUP_CONFIG_ID"], configurarNaInstalacao: true });
    expect(screen.getByTestId("cadastro-meta-indisponivel")).toHaveTextContent("META_EMBEDDED_SIGNUP_CONFIG_ID");
    rerender(
      <BotaoCadastroIncorporado disponivel={false} faltando={["META_APP_ID"]} versaoDaGraph="" configurarNaInstalacao={false} jaConectado={false} />,
    );
    expect(screen.getByTestId("cadastro-meta-indisponivel")).not.toHaveTextContent("META_APP_ID");
    expect(screen.queryByTestId("btn-cadastro-meta")).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });
});

describe("formulário manual continua na tela", () => {
  it("sem o cadastro disponível, o formulário manual vem ABERTO e completo", () => {
    estadoDoCanal = { ...estadoDoCanal, cadastroIncorporado: { disponivel: false, faltando: ["META_APP_ID"], versaoDaGraph: "v22.0", configurarNaInstalacao: false } };
    render(<CanalOficialClient />);
    expect(screen.getByTestId("conexao-manual")).toHaveAttribute("open");
    expect(screen.getByLabelText("ID do número de telefone")).toBeVisible();
    expect(screen.getByLabelText("ID da conta do WhatsApp Business")).toBeVisible();
    expect(screen.getByLabelText("Token de acesso")).toBeVisible();
    expect(screen.getByTestId("btn-conectar")).toBeInTheDocument();
  });

  it("com o cadastro disponível, o manual fica recolhido em 'Conexão manual / avançado' — mas existe", () => {
    estadoDoCanal = { ...estadoDoCanal, cadastroIncorporado: { disponivel: true, faltando: [], versaoDaGraph: "v22.0", configurarNaInstalacao: false } };
    render(<CanalOficialClient />);
    const manual = screen.getByTestId("conexao-manual");
    expect(manual).not.toHaveAttribute("open");
    expect(manual).toHaveTextContent("Conexão manual / avançado");
    expect(screen.getByTestId("btn-conectar")).toBeInTheDocument();
    expect(screen.getByTestId("cadastro-meta")).toBeInTheDocument();
  });

  it("servidor antigo (sem o campo novo) mantém o formulário manual aberto", () => {
    render(<CanalOficialClient />);
    expect(screen.getByTestId("conexao-manual")).toHaveAttribute("open");
  });
});
