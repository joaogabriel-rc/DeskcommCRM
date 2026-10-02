import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * 0507 · A TELA DISTINGUE EDITÁVEL, EM USO E HISTÓRICO.
 *
 * O banco é quem recusa (gatilho); a tela tem de CONTAR a mesma coisa, senão a
 * pessoa edita, clica em Salvar e só então descobre — ou pior, acha que salvou.
 * Aqui: a regra de somente leitura (disparo pergunta ao banco; Automações segue
 * `active`), o aviso com o motivo e a contagem, a saída "Duplicar disparo" que
 * leva para a cópia, e o Salvar que some quando nada pode ser gravado.
 *
 * Sabotagem medida: `canvasSomenteLeitura` voltar a olhar só `status` → os
 * casos de disparo pausado (editável com fluxo `active`) e histórico com fluxo
 * `draft` ficam vermelhos.
 */

const h = vi.hoisted(() => ({ push: vi.fn(), duplicar: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/disparos/useDisparos", () => ({
  useDuplicarDisparo: () => ({ mutateAsync: h.duplicar, isPending: false }),
}));
vi.mock("@/hooks/flows/useFlow", () => ({
  useUpdateFlowStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useFlowExecutions: () => ({ data: [], isLoading: false }),
  useRenameFlow: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AvisoDeFluxoProtegido } from "@/components/disparos/AvisoDeFluxoProtegido";
import { PublishBar } from "@/app/app/flows/[id]/_components/PublishBar";
import type { FlowDetailRow } from "@/hooks/flows/useFlow";
import { canvasSomenteLeitura, recusaDeProtecao, type UsoDoFluxo } from "@/lib/flows/uso";

const uso = (estado: UsoDoFluxo["estado"], vivas = 0): UsoDoFluxo => ({
  escopo: "disparo",
  estado,
  vivas,
  usado: estado !== "editavel",
  disparo_status: "completed",
});

afterEach(() => cleanup());
beforeEach(() => {
  h.push.mockReset();
  h.duplicar.mockReset();
});

describe("canvasSomenteLeitura — a mesma régua do banco", () => {
  it.each([
    ["disparo editável, fluxo `active` (pausado antes de alguém entrar)", { status: "active", broadcast_id: "d" }, uso("editavel"), false],
    ["disparo histórico, fluxo `draft`", { status: "draft", broadcast_id: "d" }, uso("historico"), true],
    ["disparo em uso", { status: "active", broadcast_id: "d" }, uso("em_uso"), true],
    ["disparo sem resposta do servidor: protegido, por segurança", { status: "draft", broadcast_id: "d" }, null, true],
    ["Automações ativo", { status: "active", broadcast_id: null }, null, true],
    ["Automações rascunho", { status: "draft", broadcast_id: null }, null, false],
  ] as const)("%s → %s", (_d, flow, u, esperado) => {
    expect(canvasSomenteLeitura(flow, u)).toBe(esperado);
  });

  it("recusaDeProtecao lê o PT409 do banco e ignora o resto", () => {
    expect(recusaDeProtecao({ code: "PT409", message: "flow_protegido:em_uso" })).toEqual({ tipo: "flow_protegido", estado: "em_uso" });
    expect(recusaDeProtecao({ code: "PT409", message: "disparo_com_historico" })).toEqual({ tipo: "disparo_com_historico" });
    expect(recusaDeProtecao({ code: "23505", message: "flow_protegido:em_uso" })).toBeNull();
    expect(recusaDeProtecao(null)).toBeNull();
  });
});

describe("o aviso do fluxo protegido", () => {
  it("histórico: diz que é a definição usada, conta quem ainda pode clicar, e oferece duplicar", async () => {
    const user = userEvent.setup();
    h.duplicar.mockResolvedValue({ broadcast_id: "d-novo", flow_id: "f-novo" });
    render(<AvisoDeFluxoProtegido uso={uso("historico", 1)} broadcastId="d1" />);
    const aviso = screen.getByTestId("aviso-fluxo-protegido");
    expect(aviso.getAttribute("data-estado")).toBe("historico");
    expect(screen.getByTestId("aviso-fluxo-protegido-titulo").textContent).toBe("Definição histórica — somente leitura");
    expect(aviso.textContent).toContain("Esta é a definição que o disparo usou");
    expect(screen.getByTestId("aviso-fluxo-protegido-vivas").textContent).toContain("1");
    await user.click(screen.getByTestId("duplicar-disparo"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/app/disparos/d-novo"));
  });

  it("em uso: diz que há contatos em execução, com a contagem", () => {
    render(<AvisoDeFluxoProtegido uso={uso("em_uso", 3)} broadcastId="d1" />);
    expect(screen.getByTestId("aviso-fluxo-protegido-titulo").textContent).toBe("Fluxo em uso — somente leitura");
    expect(screen.getByTestId("aviso-fluxo-protegido-vivas").textContent).toContain("Contatos com o fluxo em execução agora:");
    expect(screen.getByTestId("aviso-fluxo-protegido-vivas").textContent).toContain("3");
    expect(screen.getByTestId("duplicar-disparo")).toBeTruthy();
  });

  it("editável, Automações ou sem resposta: nada aparece", () => {
    const { container, rerender } = render(<AvisoDeFluxoProtegido uso={uso("editavel")} broadcastId="d1" />);
    expect(container.textContent).toBe("");
    rerender(<AvisoDeFluxoProtegido uso={{ ...uso(null), escopo: "automacao" }} broadcastId="d1" />);
    expect(container.textContent).toBe("");
    rerender(<AvisoDeFluxoProtegido uso={null} broadcastId="d1" />);
    expect(container.textContent).toBe("");
  });
});

describe("a barra do construtor", () => {
  const fluxo = (over: Partial<FlowDetailRow>): FlowDetailRow =>
    ({
      id: "f1",
      organization_id: "org",
      name: "Disparo: x",
      description: null,
      status: "active",
      trigger_type: "broadcast",
      trigger_config: {},
      version: 2,
      broadcast_id: "d1",
      created_at: "",
      updated_at: "",
      nodes: [],
      edges: [],
      ...over,
    }) as unknown as FlowDetailRow;

  it.each([
    ["histórico", uso("historico"), "Histórico", false],
    ["em uso", uso("em_uso"), "Em uso", false],
    ["editável (pausado antes de alguém entrar)", uso("editavel"), null, true],
  ] as const)("disparo %s: selo %s, Salvar visível = %s", (_d, u, selo, salvar) => {
    render(<PublishBar flowId="f1" flow={fluxo({ uso: u })} onSave={vi.fn()} saving={false} />);
    if (selo) expect(screen.getByTestId("estado-do-fluxo").textContent).toBe(selo);
    else expect(screen.queryByTestId("estado-do-fluxo")).toBeNull();
    expect(!!screen.queryByTestId("salvar-fluxo")).toBe(salvar);
  });

  it("Automações: Salvar some com o fluxo ativo e aparece no rascunho, como sempre", () => {
    const { rerender } = render(
      <PublishBar flowId="fa" flow={fluxo({ broadcast_id: null, status: "active", uso: null })} onSave={vi.fn()} saving={false} />,
    );
    expect(screen.queryByTestId("salvar-fluxo")).toBeNull();
    rerender(<PublishBar flowId="fa" flow={fluxo({ broadcast_id: null, status: "draft", uso: null })} onSave={vi.fn()} saving={false} />);
    expect(screen.getByTestId("salvar-fluxo")).toBeTruthy();
  });
});
