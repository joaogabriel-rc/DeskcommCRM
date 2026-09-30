import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * A FICHA DO CONTATO: tags como chips e TODOS os campos personalizados.
 *
 * Antes, as tags eram um campo de texto com vírgula (apagar uma letra a mais
 * levava a vizinha; uma tag com vírgula no nome virava duas) e só apareciam os
 * campos... que apareciam. Agora: "+ Adicionar tag" abre a lista pesquisável e
 * ACRESCENTA; cada chip sai sozinho; cada campo da organização aparece com o
 * valor ou "Não definido", e um clique o preenche ali mesmo.
 *
 * O que sai do diálogo é o payload do PATCH — e o PATCH (org-escopado) é o de
 * sempre, medido pelo lado do servidor em `contato-ficha-persistencia.test.ts`.
 *
 * Sabotagem medida: trocar `acrescentarTag` por `[nome]` (substituir em vez de
 * somar) deixa vermelho o caso ⭐.
 */

const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/catalogo/useOpcoesDeEtiqueta", () => ({
  useOpcoesDeEtiqueta: () => ({
    opcoes: ["cci_tem_duvida", "decore_alunos", "vip"],
    doRegistro: new Set<string>(),
    carregando: false,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import {
  acrescentarTag,
  campoVazio,
  definirCampo,
  limparCampo,
  removerTag,
  valorParaTela,
} from "@/lib/contacts/ficha-do-contato";
import type { Contact } from "@/lib/types/contacts";

const DEFS: CustomFieldDef[] = [
  { key: "cidade", label: "Cidade", type: "text" },
  { key: "onboarding", label: "Onboarding", type: "text" },
  {
    key: "plano",
    label: "Plano",
    type: "select",
    options: [
      { value: "ouro", label: "Ouro" },
      { value: "prata", label: "Prata" },
    ],
  },
];

const contato = {
  id: "c-1",
  organization_id: "org-a",
  name: "Kassiano",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: ["vip"],
  custom_fields: { cidade: "Recife" },
} as unknown as Contact;

beforeEach(() => {
  h.mutateAsync.mockReset().mockResolvedValue({});
});
afterEach(() => cleanup());

describe("as regras puras da ficha", () => {
  it("acrescentar soma sem tirar as outras, na forma que o servidor grava, e não repete", () => {
    expect(acrescentarTag(["vip"], "DECORE_ALUNOS")).toEqual(["vip", "decore_alunos"]);
    expect(acrescentarTag(["vip"], " VIP ")).toEqual(["vip"]);
    expect(acrescentarTag(["vip"], "   ")).toEqual(["vip"]);
  });

  it("remover tira só a escolhida", () => {
    expect(removerTag(["vip", "lead", "cliente"], "lead")).toEqual(["vip", "cliente"]);
  });

  it("limpar tira a CHAVE (e não grava vazio); definir vazio também limpa; false e 0 são valores", () => {
    expect(limparCampo({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
    expect(definirCampo({ a: "x" }, "a", "")).toEqual({});
    expect(definirCampo({}, "a", "y")).toEqual({ a: "y" });
    expect(campoVazio(false)).toBe(false);
    expect(campoVazio(0)).toBe(false);
    expect(campoVazio([])).toBe(true);
  });

  it("o valor na tela: rótulo da opção, sim/não, lista — e null para \"Não definido\"", () => {
    expect(valorParaTela(DEFS[2]!, "ouro")).toBe("Ouro");
    expect(valorParaTela({ type: "boolean" }, false)).toBe("Não");
    expect(valorParaTela({ type: "list" }, ["a", "b"])).toBe("a, b");
    expect(valorParaTela({ type: "text" }, "  ")).toBeNull();
  });
});

describe("o diálogo Editar contato", () => {
  function abrir(defs = DEFS) {
    return render(<EditContactDialog contact={contato} open onOpenChange={() => {}} customFieldDefs={defs} />);
  }

  it("mostra TODOS os campos da organização: o preenchido com o valor, os outros como \"Não definido\"", () => {
    abrir();
    const campos = screen.getByTestId("ficha-campos");
    expect(within(campos).getByTestId("campo-cidade").textContent).toContain("Recife");
    expect(within(campos).getAllByTestId("nao-definido")).toHaveLength(2);
    expect(within(campos).getByRole("link", { name: "Gerenciar campos personalizados" })).toBeTruthy();
  });

  it("⭐ adicionar tag pela lista SOMA à que já estava; remover tira só ela; o PATCH leva a lista inteira", async () => {
    const user = userEvent.setup();
    abrir();
    await user.click(screen.getByTestId("ficha-adicionar-tag"));
    // A que já está no contato não é oferecida de novo.
    expect(screen.queryByRole("option", { name: "vip" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "cci_tem_duvida" }));
    await user.click(screen.getByTestId("ficha-adicionar-tag"));
    await user.click(screen.getByRole("option", { name: "decore_alunos" }));

    const tags = screen.getByTestId("ficha-tags");
    expect(within(tags).getAllByRole("listitem").map((li) => li.textContent?.replace("×", ""))).toEqual([
      "vip",
      "cci_tem_duvida",
      "decore_alunos",
    ]);

    await user.click(within(tags).getByRole("button", { name: "Remover tag vip" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync.mock.calls[0]![0].tags).toEqual(["cci_tem_duvida", "decore_alunos"]);
  });

  it("uma tag que não existe pode ser criada pela busca", async () => {
    const user = userEvent.setup();
    abrir();
    await user.click(screen.getByTestId("ficha-adicionar-tag"));
    await user.type(screen.getByRole("textbox", { name: "Buscar tag" }), "Nova Tag");
    await user.click(screen.getByRole("button", { name: /Criar tag/ }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(h.mutateAsync.mock.calls[0]![0].tags).toEqual(["vip", "nova tag"]);
  });

  it("preencher um campo \"Não definido\" e LIMPAR um preenchido: o PATCH leva o mapa sem a chave limpa", async () => {
    const user = userEvent.setup();
    abrir();
    await user.click(screen.getByRole("button", { name: "Editar campo Onboarding" }));
    await user.type(screen.getByLabelText("Onboarding"), "feito");
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    expect(screen.getByTestId("campo-onboarding").textContent).toContain("feito");

    await user.click(screen.getByRole("button", { name: "Editar campo Cidade" }));
    await user.click(screen.getByRole("button", { name: "Limpar" }));
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    expect(within(screen.getByTestId("campo-cidade")).getByTestId("nao-definido")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(h.mutateAsync.mock.calls[0]![0].custom_fields).toEqual({ onboarding: "feito" });
  });

  it("com muitos campos, mostra os primeiros e \"Mostrar todos\" traz o resto — campo novo aparece sem declarar em outro lugar", async () => {
    const user = userEvent.setup();
    const muitos: CustomFieldDef[] = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, label: `Campo ${i}`, type: "text" }));
    abrir(muitos);
    expect(screen.getAllByTestId("nao-definido")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Mostrar todos (9)" }));
    expect(screen.getAllByTestId("nao-definido")).toHaveLength(9);
  });
});
