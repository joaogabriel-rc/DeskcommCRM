import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * "VER FLUXO" NUM DISPARO QUE JÁ SAIU — abre, não salva.
 *
 * O defeito relatado: no disparo concluído, clicar em "Ver fluxo" mostrava
 * "Pause o disparo antes de editar — senão metade do público recebe uma
 * mensagem e metade recebe outra." e não abria nada. A causa, medida no código
 * em produção (d180e680): o botão chamava `irParaConstrutor`, que fazia
 * `salvarTudo()` — um PATCH de edição — ANTES do `router.push`. Fora de
 * `draft`/`paused` a rota recusa esse PATCH com 409, o `mutateAsync` lança e a
 * navegação nunca roda.
 *
 * Aqui o salvamento RECUSA exatamente como a rota recusa, de propósito: se o
 * clique voltar a salvar antes de navegar, o push não acontece.
 *
 * Sabotagem medida: tirar o desvio `if (!editavel)` de `irParaConstrutor` →
 * os dois casos ⭐ ficam vermelhos (push não chamado, PATCH chamado); os de
 * estado editável continuam verdes.
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  salvar: vi.fn(),
  disparo: null as unknown,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-a", role: "manager", timezone: "America/Sao_Paulo" } }),
}));
vi.mock("@/hooks/catalogo/useCatalogo", () => ({
  useTags: () => ({ data: [], isLoading: false }),
  useCamposDoContato: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/catalogo/useOpcoesDeEtiqueta", () => ({ useOpcoesDeEtiqueta: () => ({ opcoes: [], carregando: false }) }));
vi.mock("@/hooks/channels/useTemplates", () => ({ useTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/disparos/useDisparos", () => ({
  useDisparo: () => ({ data: h.disparo }),
  useSalvarDisparo: () => ({ mutateAsync: h.salvar, isPending: false }),
  useAcaoDeDisparo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDuplicarDisparo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePreviaDePublico: () => ({ data: { total: 2 }, isLoading: false }),
}));
// O painel dos Fluxos e a criação de modelo não entram no caminho do botão.
vi.mock("@/app/app/flows/[id]/_components/NodeConfigPanel", () => ({ ModeloDaMensagem: () => null }));
vi.mock("@/components/connections/TemplatesClient", () => ({ CriarModeloOficial: () => null }));

import { DisparoEditor } from "@/app/app/disparos/[id]/_components/DisparoEditor";
import type { DisparoDetalhe } from "@/hooks/disparos/useDisparos";

const FLUXO_ID = "85a43491-81a6-4c19-893c-1ae9b62b781c";

function disparo(over: Partial<DisparoDetalhe> = {}): DisparoDetalhe {
  return {
    id: "fbcd0669-fbe4-4556-892d-5a1722de93ff",
    organization_id: "org-a",
    name: "asce",
    status: "completed",
    segment: { tags_all: ["teste1"], tags_any: [], tags_none: [], fields: [], fields_any: [], fields_none: [] },
    message: { body: "", window_mode: "outside_24h", template_values: {} },
    scheduled_at: null,
    started_at: "2026-10-01T22:25:01.806Z",
    finished_at: "2026-10-01T22:25:24.053Z",
    total_recipients: 2,
    sent_count: 0,
    failed_count: 2,
    skipped_count: 0,
    in_flow_count: 0,
    last_error: null,
    next_run_at: null,
    created_at: "2026-10-01T03:22:32.734Z",
    updated_at: "2026-10-01T22:25:39.006Z",
    modo: "fluxo",
    fluxo: { id: FLUXO_ID, status: "active" },
    problemas: [],
    ...over,
  } as DisparoDetalhe;
}

/** O 409 que a rota devolve fora de draft/paused, como o hook o propaga. */
const RECUSA_DA_ROTA = new Error(
  "Pause o disparo antes de editar — senão metade do público recebe uma mensagem e metade recebe outra.",
);

function montar(d: DisparoDetalhe) {
  h.disparo = d;
  render(<DisparoEditor inicial={d} />);
}

afterEach(() => cleanup());
beforeEach(() => {
  h.push.mockReset();
  h.salvar.mockReset();
  h.salvar.mockRejectedValue(RECUSA_DA_ROTA);
});

describe('"Ver fluxo" em disparo que não está em edição', () => {
  it.each(["completed", "running"] as const)(
    "⭐ disparo %s: abre o fluxo sem tentar salvar, mesmo com o PATCH recusando",
    async (status) => {
      const user = userEvent.setup();
      montar(disparo({ status }));
      // Em andamento a seção começa recolhida — a pessoa abre "Conteúdo" primeiro.
      if (!screen.queryByTestId("configurar-fluxo")) {
        await user.click(within(screen.getByTestId("secao-conteudo")).getByRole("button", { expanded: false }));
      }
      const botao = screen.getByTestId("configurar-fluxo");
      expect(botao.textContent).toContain("Ver fluxo");
      await user.click(botao);
      await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/app/flows/${FLUXO_ID}`));
      expect(h.salvar).not.toHaveBeenCalled();
    },
  );
});

describe("disparo em edição continua salvando antes de abrir", () => {
  it("rascunho em modo fluxo: salva nome/público/envio e depois abre", async () => {
    const user = userEvent.setup();
    h.salvar.mockResolvedValue({ fluxo: { id: FLUXO_ID, status: "draft" } });
    montar(disparo({ status: "draft", fluxo: { id: FLUXO_ID, status: "draft" }, started_at: null, finished_at: null }));
    const botao = screen.getByTestId("configurar-fluxo");
    expect(botao.textContent).toContain("Abrir o Construtor de Fluxos");
    await user.click(botao);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/app/flows/${FLUXO_ID}`));
    expect(h.salvar).toHaveBeenCalledTimes(1);
    expect(h.salvar.mock.calls[0]![0]).toMatchObject({ name: "asce" });
    expect(h.salvar.mock.calls[0]![0]).not.toHaveProperty("modo");
    expect(h.salvar.mock.invocationCallOrder[0]!).toBeLessThan(h.push.mock.invocationCallOrder[0]!);
  });

  it("pausado: continua editável, então salva primeiro e só depois abre", async () => {
    const user = userEvent.setup();
    h.salvar.mockResolvedValue({ fluxo: { id: FLUXO_ID, status: "active" } });
    montar(disparo({ status: "paused" }));
    await user.click(screen.getByTestId("configurar-fluxo"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/app/flows/${FLUXO_ID}`));
    expect(h.salvar).toHaveBeenCalledTimes(1);
    expect(h.salvar.mock.invocationCallOrder[0]!).toBeLessThan(h.push.mock.invocationCallOrder[0]!);
  });
});

describe("0507 · o cartão do fluxo conta o estado de edição", () => {
  it("pausado depois que alguém entrou: o fluxo é histórico — 'Ver fluxo' e o aviso com Duplicar", () => {
    montar(
      disparo({
        status: "paused",
        fluxo: {
          id: FLUXO_ID,
          status: "active",
          uso: { escopo: "disparo", estado: "historico", vivas: 0, usado: true, disparo_status: "paused" },
        },
      }),
    );
    expect(screen.getByTestId("configurar-fluxo").textContent).toContain("Ver fluxo");
    expect(screen.getByTestId("aviso-fluxo-protegido").getAttribute("data-estado")).toBe("historico");
    expect(screen.getByTestId("duplicar-disparo")).toBeTruthy();
  });

  it("pausado antes de alguém entrar: o fluxo segue editável — sem aviso", () => {
    montar(
      disparo({
        status: "paused",
        fluxo: {
          id: FLUXO_ID,
          status: "active",
          uso: { escopo: "disparo", estado: "editavel", vivas: 0, usado: false, disparo_status: "paused" },
        },
      }),
    );
    expect(screen.getByTestId("configurar-fluxo").textContent).toContain("Abrir o Construtor de Fluxos");
    expect(screen.queryByTestId("aviso-fluxo-protegido")).toBeNull();
  });
});
