/**
 * A rota e o cartão da sincronização do app WhatsApp Business (0495).
 *
 * Rota: a organização vem da sessão (nunca do corpo), só `admin`, guarda de
 * suporte antes do efeito, e o desfecho de cada tipo volta para a tela.
 * Cartão: só aparece em coexistência, mostra prazo e estado, e o botão some
 * quando tudo já foi pedido ou o prazo passou.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/channels/meta/sincronizacao", () => ({
  lerSincronizacao: vi.fn(),
  solicitarSincronizacaoDoApp: vi.fn(),
}));

const estadoDaTela: { data: unknown } = { data: undefined };
const mutate = vi.fn();
vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  useSincronizacaoDoApp: () => ({ data: estadoDaTela.data }),
  useSolicitarSincronizacaoDoApp: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { GET, POST } from "@/app/api/v1/channels/official/sincronizacao/route";
import { SincronizacaoDoApp } from "@/components/connections/SincronizacaoDoApp";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerSincronizacao, solicitarSincronizacaoDoApp } from "@/lib/channels/meta/sincronizacao";
import { requireSupportWrite } from "@/lib/impersonate/support";

const ORG = "org-1";
const pedido = (metodo: string, corpo?: unknown) =>
  new NextRequest("https://crm.exemplo.com/api/v1/channels/official/sincronizacao", {
    method: metodo,
    ...(corpo !== undefined ? { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } } : {}),
  });

const SITUACAO = {
  disponivel: true,
  channelSessionId: "s-1",
  onboardingEm: "2026-09-26T00:43:08.000Z",
  prazo: "2026-09-27T00:43:08.000Z",
  dentroDoPrazo: true,
  contatos: null,
  historico: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: null },
    org: { orgId: ORG, role: "admin" },
  } as never);
  vi.mocked(lerSincronizacao).mockResolvedValue(SITUACAO as never);
  vi.mocked(solicitarSincronizacaoDoApp).mockResolvedValue({
    ok: true,
    contatos: "solicitada",
    historico: "solicitada",
    situacao: SITUACAO,
  } as never);
});

describe("rota /api/v1/channels/official/sincronizacao", () => {
  it("POST pede na organização da SESSÃO — um org_id no corpo é ignorado — e audita", async () => {
    const res = await POST(pedido("POST", { organization_id: "org-intrusa" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(solicitarSincronizacaoDoApp).mock.calls[0]![1]).toMatchObject({ organizationId: ORG });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.app_sync_requested", organizationId: ORG, resourceId: "s-1" }),
    );
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      contatos: "solicitada",
      historico: "solicitada",
    });
  });

  it("POST exige admin e a guarda de suporte ANTES do efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    expect((await POST(pedido("POST"))).status).toBe(403);
    expect(solicitarSincronizacaoDoApp).not.toHaveBeenCalled();

    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await POST(pedido("POST"))).status).toBe(403);
    expect(solicitarSincronizacaoDoApp).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole).mock.calls.at(-1)![0]).toBe("admin");
  });

  it("canal fora da coexistência é 422 com o motivo, sem auditoria", async () => {
    vi.mocked(solicitarSincronizacaoDoApp).mockResolvedValue({ ok: false, motivo: "nao_e_coexistencia" } as never);
    const res = await POST(pedido("POST"));
    expect(res.status).toBe(422);
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha inesperada é 500 sem vazar detalhe", async () => {
    vi.mocked(solicitarSincronizacaoDoApp).mockRejectedValue(new Error("detalhe interno"));
    const res = await POST(pedido("POST"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("detalhe interno");
  });

  it("GET devolve o estado da organização da sessão", async () => {
    const res = await GET(pedido("GET"));
    expect(res.status).toBe(200);
    expect(vi.mocked(lerSincronizacao).mock.calls[0]![1]).toBe(ORG);
  });
});

describe("cartão Histórico e contatos do aplicativo", () => {
  it("fora da coexistência não aparece", () => {
    estadoDaTela.data = { data: { disponivel: false, motivo: "nao_e_coexistencia" } };
    const { container } = render(<SincronizacaoDoApp conectado />);
    expect(container.innerHTML).toBe("");
  });

  it("em coexistência, dentro do prazo e nada pedido: mostra o prazo e o botão pede", () => {
    estadoDaTela.data = { data: SITUACAO };
    render(<SincronizacaoDoApp conectado />);
    expect(screen.getByTestId("sincronizacao-do-app")).toHaveTextContent("ainda não aparece nas conversas");
    expect(screen.getByTestId("sincronizacao-prazo")).toHaveTextContent("Prazo para pedir:");
    fireEvent.click(screen.getByTestId("btn-solicitar-sincronizacao"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("contatos falhou: mostra o motivo e o botão continua (nova tentativa)", () => {
    estadoDaTela.data = {
      data: { ...SITUACAO, contatos: { tipo: "contatos", status: "falhou", erro: "meta_100: Invalid parameter", request_id: null, solicitada_em: null, recebido_em: null } },
    };
    render(<SincronizacaoDoApp conectado />);
    expect(screen.getByTestId("sincronizacao-contatos")).toHaveTextContent("meta_100: Invalid parameter");
    expect(screen.getByTestId("btn-solicitar-sincronizacao")).not.toBeDisabled();
  });

  it("tudo pedido: sem botão, com o estado de cada tipo", () => {
    const aceito = { status: "solicitada", erro: null, request_id: "r", solicitada_em: "x", recebido_em: null };
    estadoDaTela.data = {
      data: { ...SITUACAO, contatos: { tipo: "contatos", ...aceito, recebido_em: "y" }, historico: { tipo: "historico", ...aceito } },
    };
    render(<SincronizacaoDoApp conectado />);
    expect(screen.queryByTestId("btn-solicitar-sincronizacao")).toBeNull();
    expect(screen.getByTestId("sincronizacao-contatos")).toHaveTextContent("dados recebidos");
    expect(screen.getByTestId("sincronizacao-historico")).toHaveTextContent("aguardando a Meta");
  });

  it("prazo vencido: sem botão, e diz o caminho de volta", () => {
    estadoDaTela.data = { data: { ...SITUACAO, dentroDoPrazo: false } };
    render(<SincronizacaoDoApp conectado />);
    expect(screen.queryByTestId("btn-solicitar-sincronizacao")).toBeNull();
    expect(screen.getByTestId("sincronizacao-prazo")).toHaveTextContent("já passou");
  });

  it("histórico recusado no aplicativo aparece como tal", () => {
    estadoDaTela.data = {
      data: {
        ...SITUACAO,
        contatos: { tipo: "contatos", status: "solicitada", erro: null, request_id: "r", solicitada_em: "x", recebido_em: "y" },
        historico: { tipo: "historico", status: "recusada", erro: "meta_2593109", request_id: "r2", solicitada_em: "x", recebido_em: "y" },
      },
    };
    render(<SincronizacaoDoApp conectado />);
    expect(screen.getByTestId("sincronizacao-historico")).toHaveTextContent("desligado no aplicativo");
    expect(screen.queryByTestId("btn-solicitar-sincronizacao")).toBeNull();
  });
});
