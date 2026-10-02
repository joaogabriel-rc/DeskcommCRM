import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * ABRIR UM DISPARO CONCLUÍDO DIRETO PELA URL MOSTRA O AVISO DE FLUXO PROTEGIDO.
 *
 * O defeito, medido no E2E `fluxo-de-disparo-historico.spec.ts:160` (CI, run
 * 37020835053): a página `app/app/disparos/[id]/page.tsx` montava o `fluxo` do
 * `initialData` com `fluxoDoDisparo()` — só `{ id, status }`, sem `uso`. O GET
 * `/api/v1/broadcasts/[id]` traz o `uso` (0507), mas com o staleTime global de
 * 30s o `initialData` é fresco e o GET nunca é refeito ao abrir; o
 * `AvisoDeFluxoProtegido` recebia `uso` ausente e não renderizava nada.
 *
 * Aqui roda a PÁGINA de verdade (o componente de servidor) sobre um Supabase
 * falso, e `useDisparo` devolve exatamente o `initialData` — o que a tela mostra
 * no produto enquanto o dado é fresco. Nenhum GET acontece neste teste.
 *
 * Sabotagem medida: voltar a página para `fluxoDoDisparo()` → o caso ⭐ e o do
 * rascunho ficam vermelhos (RPC nunca chamada, `uso` ausente no `initialData`);
 * o do disparo guiado segue verde.
 */

const FLUXO_ID = "85a43491-81a6-4c19-893c-1ae9b62b781c";
const DISPARO_ID = "fbcd0669-fbe4-4556-892d-5a1722de93ff";
const ORG = "org-a";

const h = vi.hoisted(() => ({
  linhas: {} as Record<string, unknown>,
  uso: null as unknown,
  rpc: vi.fn(),
  initialData: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "user-a" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "manager" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: h.linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
    rpc: async (nome: string, args: unknown) => {
      h.rpc(nome, args);
      return { data: h.uso, error: null };
    },
  }),
}));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: ORG, role: "manager", timezone: "America/Sao_Paulo" } }),
}));
vi.mock("@/hooks/catalogo/useCatalogo", () => ({
  useTags: () => ({ data: [], isLoading: false }),
  useCamposDoContato: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/catalogo/useOpcoesDeEtiqueta", () => ({ useOpcoesDeEtiqueta: () => ({ opcoes: [], carregando: false }) }));
vi.mock("@/hooks/channels/useTemplates", () => ({ useTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/disparos/useDisparos", () => ({
  // O `initialData` fresco É o que a tela mostra ao abrir — sem GET.
  useDisparo: (_id: string, opts?: { initialData?: unknown }) => {
    h.initialData = opts?.initialData;
    return { data: opts?.initialData };
  },
  useSalvarDisparo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAcaoDeDisparo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDuplicarDisparo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePreviaDePublico: () => ({ data: { total: 2 }, isLoading: false }),
}));
vi.mock("@/app/app/flows/[id]/_components/NodeConfigPanel", () => ({ ModeloDaMensagem: () => null }));
vi.mock("@/components/connections/TemplatesClient", () => ({ CriarModeloOficial: () => null }));

import DisparoPage from "@/app/app/disparos/[id]/page";

function linhaDoDisparo(status: string) {
  return {
    id: DISPARO_ID,
    organization_id: ORG,
    name: "Histórico",
    status,
    segment: { tags_all: ["x"], tags_any: [], tags_none: [], fields: [], fields_any: [], fields_none: [] },
    message: { body: "", window_mode: "outside_24h", template_values: {} },
    scheduled_at: null,
    started_at: status === "draft" ? null : "2026-10-01T22:25:01.806Z",
    finished_at: status === "completed" ? "2026-10-01T22:25:24.053Z" : null,
    total_recipients: 1,
    sent_count: 1,
    failed_count: 0,
    skipped_count: 0,
    in_flow_count: 0,
    last_error: null,
    next_run_at: null,
    created_at: "2026-10-01T03:22:32.734Z",
    updated_at: "2026-10-01T22:25:39.006Z",
  };
}

async function abrirDireto() {
  render(await DisparoPage({ params: Promise.resolve({ id: DISPARO_ID }) }));
}

afterEach(() => cleanup());
beforeEach(() => {
  h.linhas = {};
  h.uso = null;
  h.rpc.mockReset();
  h.initialData = undefined;
});

describe("disparo aberto direto pela URL", () => {
  it("⭐ concluído com fluxo histórico: o SSR traz o `uso` e o aviso aparece", async () => {
    h.linhas = { broadcasts: linhaDoDisparo("completed"), flows: { id: FLUXO_ID, status: "active" } };
    h.uso = { escopo: "disparo", estado: "historico", vivas: 0, usado: true, disparo_status: "completed" };

    await abrirDireto();

    expect(h.rpc).toHaveBeenCalledWith("fn_flow_estado_de_edicao", { p_flow: FLUXO_ID });
    expect(h.initialData).toMatchObject({ modo: "fluxo", fluxo: { id: FLUXO_ID, uso: { estado: "historico" } } });
    expect(screen.getByTestId("aviso-fluxo-protegido").getAttribute("data-estado")).toBe("historico");
    expect(screen.getByTestId("configurar-fluxo").textContent).toContain("Ver fluxo");
  });

  it("rascunho com fluxo editável: o `uso` chega e o aviso não aparece", async () => {
    h.linhas = { broadcasts: linhaDoDisparo("draft"), flows: { id: FLUXO_ID, status: "draft" } };
    h.uso = { escopo: "disparo", estado: "editavel", vivas: 0, usado: false, disparo_status: "draft" };

    await abrirDireto();

    expect(h.initialData).toMatchObject({ fluxo: { uso: { estado: "editavel" } } });
    expect(screen.queryByTestId("aviso-fluxo-protegido")).toBeNull();
  });

  it("disparo guiado (sem fluxo): nenhuma pergunta ao banco sobre uso, nenhum aviso", async () => {
    h.linhas = { broadcasts: linhaDoDisparo("completed") };

    await abrirDireto();

    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.initialData).toMatchObject({ modo: "guiado", fluxo: null });
    expect(screen.queryByTestId("aviso-fluxo-protegido")).toBeNull();
  });
});
