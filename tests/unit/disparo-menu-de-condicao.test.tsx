import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * O "+ CONDIÇÃO" DO PÚBLICO — o menu que abre CHEIO.
 *
 * O defeito relatado: "clico na caixa de etiquetas e não aparece nada; a tela sai
 * do formato". A causa, medida: o seletor lia só o REGISTRO de etiquetas, e numa
 * organização com etiquetas apenas aplicadas (importadas, de automação) o registro
 * vem vazio — o `Select` do Radix aberto sem item vira uma barra fina colada no
 * gatilho. Aqui o registro está VAZIO de propósito, e a lista tem de trazer as
 * etiquetas aplicadas (vocabulário).
 *
 * Sabotagem medida: `useOpcoesDeEtiqueta` voltar a ler só o registro → o caso ⭐
 * fica vermelho (a lista mostra "Nenhuma tag cadastrada…").
 */

const h = vi.hoisted(() => ({
  registroDeTags: [] as Array<{ id: string; name: string; folder: string; archived_at: null }>,
  vocabulario: ["cci_tem_duvida", "decore_alunos"],
}));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: { orgId: "org-a", role: "manager" } }) }));
vi.mock("@/hooks/catalogo/useCatalogo", () => ({
  useTags: () => ({ data: h.registroDeTags, isLoading: false }),
  useCamposDoContato: () => ({
    data: [{ id: "f1", key: "produto_interesse", label: "Produto de interesse", type: "text", options: [] }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: h.vocabulario, isLoading: false }),
}));
// O editor inteiro puxa o painel dos Fluxos; o grupo do público não precisa dele.
vi.mock("@/app/app/flows/[id]/_components/NodeConfigPanel", () => ({ ModeloDaMensagem: () => null }));
vi.mock("@/components/connections/TemplatesClient", () => ({ CriarModeloOficial: () => null }));

import { GrupoDoPublico } from "@/app/app/disparos/[id]/_components/DisparoEditor";

afterEach(() => cleanup());
beforeEach(() => {
  h.registroDeTags = [];
});

function montar(props: Partial<Parameters<typeof GrupoDoPublico>[0]> = {}) {
  const onTags = vi.fn();
  const onCampos = vi.fn();
  render(
    <GrupoDoPublico
      titulo="Incluir"
      tags={[]}
      onTags={onTags}
      campos={[]}
      onCampos={onCampos}
      grupo="fields"
      {...props}
    />,
  );
  return { onTags, onCampos };
}

describe("o menu \"+ Condição\"", () => {
  it("⭐ com o registro VAZIO, Filtros gerais › Tag lista as etiquetas já aplicadas — e escolher adiciona a condição", async () => {
    const user = userEvent.setup();
    const { onTags } = montar();
    await user.click(screen.getByTestId("adicionar-criterio-fields"));
    const menu = screen.getByTestId("menu-de-condicao-fields");
    await user.click(within(menu).getByTestId("condicao-tipo-tag"));
    expect(within(menu).queryByTestId("condicao-sem-tags")).toBeNull();
    await user.click(within(menu).getByRole("button", { name: "decore_alunos" }));
    expect(onTags).toHaveBeenCalledWith(["decore_alunos"]);
  });

  it("as três categorias: Campos do sistema adiciona com `origem: sistema`; personalizados, sem", async () => {
    const user = userEvent.setup();
    const { onCampos } = montar();
    await user.click(screen.getByTestId("adicionar-criterio-fields"));
    let menu = screen.getByTestId("menu-de-condicao-fields");
    await user.click(within(menu).getByRole("tab", { name: "Campos do sistema" }));
    await user.click(within(menu).getByRole("button", { name: "Nome" }));
    expect(onCampos).toHaveBeenLastCalledWith([{ key: "name", op: "eq", value: "", origem: "sistema" }]);

    await user.click(screen.getByTestId("adicionar-criterio-fields"));
    menu = screen.getByTestId("menu-de-condicao-fields");
    await user.click(within(menu).getByRole("tab", { name: "Campos personalizados do usuário" }));
    await user.click(within(menu).getByRole("button", { name: "Produto de interesse" }));
    expect(onCampos).toHaveBeenLastCalledWith([{ key: "produto_interesse", op: "eq", value: "" }]);
  });

  it("a busca atravessa as categorias", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByTestId("adicionar-criterio-fields"));
    const menu = screen.getByTestId("menu-de-condicao-fields");
    await user.type(within(menu).getByRole("textbox", { name: "Buscar condição" }), "produto");
    expect(within(menu).getByRole("button", { name: "Produto de interesse" })).toBeTruthy();
    expect(within(menu).queryByRole("button", { name: "decore_alunos" })).toBeNull();
  });

  it("sem nenhuma etiqueta em lugar nenhum, o vazio é uma FRASE — nunca um vão", async () => {
    const user = userEvent.setup();
    h.vocabulario = [];
    montar();
    await user.click(screen.getByTestId("adicionar-criterio-fields"));
    const menu = screen.getByTestId("menu-de-condicao-fields");
    await user.click(within(menu).getByTestId("condicao-tipo-tag"));
    expect(within(menu).getByTestId("condicao-sem-tags").textContent).toMatch(/Nenhuma tag/);
    h.vocabulario = ["cci_tem_duvida", "decore_alunos"];
  });

  it("condições existentes aparecem com o nome legível e saem uma a uma", async () => {
    const user = userEvent.setup();
    const { onTags } = montar({
      tags: ["vip", "lead"],
      campos: [{ key: "produto_interesse", op: "contains", value: "curso" }],
    });
    expect(screen.getAllByTestId("condicao-tag")).toHaveLength(2);
    expect(screen.getByTestId("condicao-campo").textContent).toContain("Produto de interesse");
    await user.click(screen.getByRole("button", { name: "Remover condição vip" }));
    expect(onTags).toHaveBeenCalledWith(["lead"]);
  });
});
