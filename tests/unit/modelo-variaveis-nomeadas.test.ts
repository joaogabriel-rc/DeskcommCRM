import { describe, expect, it } from "vitest";

import { buildComponents } from "@/lib/channels/meta/build-components";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { templatesToRows } from "@/lib/channels/meta/template-sync";
import { contarVariaveis, lerConteudo, montarComponents, paraFormulario } from "@/lib/channels/template-conteudo";
import {
  formatoDosComponentes,
  formatoDosTextos,
  formatoEfetivo,
  lerVariaveis,
} from "@/lib/channels/template-variaveis";
import { renderFlowTemplate } from "@/lib/flows/template";
import { CAMPOS_DO_SISTEMA, valorPadraoDaVariavel } from "@/lib/variaveis/campos-do-sistema";

/**
 * AS VARIÁVEIS DE UM MODELO, com uma régua só — do formulário ao envio.
 *
 * O caso que produziu esta suíte: `var1_teste`, criado com `{{var1}}` e
 * `{{var2}}`. A Meta o tratou como NAMED; o CRM gravou POSITIONAL por
 * presunção e enviou parâmetros sem `parameter_name` → 132000 ("number of
 * localizable_params (2) does not match the expected number of params (0)").
 */

describe("a régua: lerVariaveis", () => {
  it("lê posicional e nomeada, distintas, na ordem da primeira aparição", () => {
    expect(lerVariaveis("{{2}} oi {{1}} e {{2}}").variaveis).toEqual([
      { nome: "2", posicional: true },
      { nome: "1", posicional: true },
    ]);
    expect(lerVariaveis("Olá {{primeiro_nome}}, pedido {{ pedido_id }} — {{primeiro_nome}}").variaveis).toEqual([
      { nome: "primeiro_nome", posicional: false },
      { nome: "pedido_id", posicional: false },
    ]);
  });

  it("marcador que não é número nem nome válido é APONTADO, não ignorado", () => {
    // `{{VAR1}}` era o marcador que passava mudo pelo textarea.
    expect(lerVariaveis("{{VAR1}} {{contact.name}} {{}} {{ok_1}}")).toEqual({
      variaveis: [{ nome: "ok_1", posicional: false }],
      invalidas: ["{{VAR1}}", "{{contact.name}}", "{{}}"],
    });
  });

  it("formato: um só por modelo; os dois juntos é MISTO", () => {
    expect(formatoDosTextos(["sem variável"])).toBeNull();
    expect(formatoDosTextos(["{{1}}", "{{2}}"])).toBe("POSITIONAL");
    expect(formatoDosTextos(["{{var1}}"])).toBe("NAMED");
    expect(formatoDosTextos(["{{1}}", "{{nome}}"])).toBe("MISTO");
  });

  it("contarVariaveis: posicional pelo maior índice, nomeada por nome distinto", () => {
    expect(contarVariaveis("{{1}} {{3}}")).toBe(3);
    expect(contarVariaveis("{{var1}}\n{{var2}} {{var1}}")).toBe(2);
    expect(contarVariaveis("texto")).toBe(0);
  });
});

describe("criação e edição: exemplos separados da variável e do valor real", () => {
  it("1, 2 e 3 variáveis → 1, 2 e 3 exemplos, na ordem do texto", () => {
    for (const [texto, esperado] of [
      ["{{a}}", ["a"]],
      ["{{b}} {{a}}", ["b", "a"]],
      ["{{c}} {{a}} {{b}}", ["c", "a", "b"]],
    ] as const) {
      const comps = montarComponents({
        body: texto,
        exemplos: Object.fromEntries(esperado.map((n) => [n, `ex-${n}`])),
      }) as Array<{ type: string; example?: { body_text_named_params?: Array<{ param_name: string; example: string }> } }>;
      const nomeados = comps.find((c) => c.type === "BODY")!.example!.body_text_named_params!;
      expect(nomeados.map((n) => n.param_name)).toEqual(esperado);
      expect(nomeados.map((n) => n.example)).toEqual(esperado.map((n) => `ex-${n}`));
    }
  });

  it("cabeçalho nomeado leva o PRÓPRIO exemplo, escrito por quem cria", () => {
    const comps = montarComponents({
      body: "Olá {{primeiro_nome}}",
      exemplos: { primeiro_nome: "João" },
      cabecalho: { texto: "Pedido {{pedido}}" },
      exemploCabecalho: "#123",
    }) as Array<{ type: string; example?: unknown }>;
    expect(comps.find((c) => c.type === "HEADER")!.example).toEqual({
      header_text_named_params: [{ param_name: "pedido", example: "#123" }],
    });
  });

  it("editar: o conteúdo lido volta ao formulário com os exemplos por nome (ida e volta)", () => {
    const comps = montarComponents({
      body: "{{var1}}\n{{var2}}",
      exemplos: { var1: "mensagem teste", var2: "pedido saiu para entrega" },
    });
    const f = paraFormulario(lerConteudo(comps));
    expect(f.corpo).toBe("{{var1}}\n{{var2}}");
    expect(f.exemplosPorNome).toEqual({ var1: "mensagem teste", var2: "pedido saiu para entrega" });
    expect(montarComponents({ body: f.corpo, exemplos: f.exemplosPorNome })).toEqual(comps);
  });

  it("posicional continua como era: body_text por posição", () => {
    const comps = montarComponents({ body: "Olá {{1}}, pedido {{2}}", exemplos: ["Ana", "123"] }) as Array<{
      type: string;
      example?: unknown;
    }>;
    expect(comps.find((c) => c.type === "BODY")!.example).toEqual({ body_text: [["Ana", "123"]] });
    expect(formatoDosComponentes(comps)).toBe("POSITIONAL");
  });
});

describe("sincronização: o formato do espelho", () => {
  const graph = (t: Record<string, unknown>) => ({ data: [{ name: "x", language: "pt_BR", status: "APPROVED", ...t }] });

  it("o declarado pela Meta vale (NAMED e POSITIONAL)", () => {
    const [nomeado] = templatesToRows(
      graph({ parameter_format: "NAMED", components: [{ type: "BODY", text: "{{var1}}" }] }),
      "org",
      "waba",
    );
    const [posicional] = templatesToRows(
      graph({ parameter_format: "POSITIONAL", components: [{ type: "BODY", text: "{{1}}" }] }),
      "org",
      "waba",
    );
    expect(nomeado!.parameter_format).toBe("NAMED");
    expect(posicional!.parameter_format).toBe("POSITIONAL");
  });

  it("campo omitido num modelo com {{var1}}: NAMED pelos tokens, nunca POSITIONAL presumido", () => {
    const [linha] = templatesToRows(graph({ components: [{ type: "BODY", text: "{{var1}} {{var2}}" }] }), "org", "waba");
    expect(linha!.parameter_format).toBe("NAMED");
  });
});

describe("payload de envio: o contrato do espelho ERRADO se corrige", () => {
  const COMPONENTES = [{ type: "BODY", text: "{{var1}}\n{{var2}}" }];

  it("linha gravada POSITIONAL com {{var1}} (o var1_teste de produção) envia com parameter_name", () => {
    const contrato = deriveTemplateContract({
      name: "var1_teste",
      language: "pt_BR",
      parameter_format: "POSITIONAL",
      components: COMPONENTES as never,
    });
    expect(contrato.parameterFormat).toBe("NAMED");
    expect(buildComponents(contrato, { var1: "Olá Ana", var2: "Seu pedido saiu" })).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "var1", text: "Olá Ana" },
          { type: "text", parameter_name: "var2", text: "Seu pedido saiu" },
        ],
      },
    ]);
  });

  it("POSITIONAL de verdade continua sem parameter_name", () => {
    const contrato = deriveTemplateContract({
      name: "p",
      language: "pt_BR",
      parameter_format: "POSITIONAL",
      components: [{ type: "BODY", text: "Oi {{1}}" }] as never,
    });
    expect(buildComponents(contrato, { "1": "Ana" })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ana" }] },
    ]);
  });

  it("formatoEfetivo: só corrige POSITIONAL→NAMED; NAMED numérico continua NAMED", () => {
    expect(formatoEfetivo("NAMED", [{ type: "BODY", text: "{{1}}" }])).toBe("NAMED");
    expect(formatoEfetivo("POSITIONAL", [{ type: "BODY", text: "{{1}}" }])).toBe("POSITIONAL");
    expect(formatoEfetivo(null, [{ type: "BODY", text: "{{nome}}" }])).toBe("NAMED");
  });
});

describe("valor dinâmico no fluxo e no disparo — separado do exemplo", () => {
  const contexto = { contact: { name: "João da Silva Souza", email: "j@x.test", custom_fields: { cpf: "123" } } };

  it("Primeiro nome e Sobrenome são CALCULADOS do nome do contato", () => {
    expect(renderFlowTemplate("{{contact.first_name}} | {{contact.last_name}}", contexto)).toBe("João | da Silva Souza");
    expect(renderFlowTemplate("{{contact.first_name}}", { contact: { name: null } })).toBe("");
  });

  it("variável criada pelo autocomplete já sabe de onde vem o valor; nome livre não", () => {
    expect(valorPadraoDaVariavel("primeiro_nome", [])).toBe("{{contact.first_name}}");
    expect(valorPadraoDaVariavel("cpf", [{ key: "cpf" }])).toBe("{{contact.custom_fields.cpf}}");
    expect(valorPadraoDaVariavel("var1", [])).toBeNull();
    expect(renderFlowTemplate(valorPadraoDaVariavel("cpf", [{ key: "cpf" }])!, contexto)).toBe("123");
  });

  it("toda chave de campo do sistema é um nome que a Meta aceita", () => {
    for (const c of CAMPOS_DO_SISTEMA) expect(lerVariaveis(`{{${c.chave}}}`).variaveis).toHaveLength(1);
  });
});
