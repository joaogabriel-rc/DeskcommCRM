import { describe, expect, it } from "vitest";

import {
  bindingState,
  explainBindingState,
  isSendable,
  type CurrentTemplate,
  type TemplateBinding,
} from "@/lib/channels/meta/template-binding";
import { hashContract } from "@/lib/channels/meta/contract-hash";

const SALVO: TemplateBinding = {
  name: "pedido_confirmado",
  language: "pt_BR",
  contractHash: "abc123",
  values: { "1": "{{lead.nome}}" },
};

const ATUAL: CurrentTemplate = {
  name: "pedido_confirmado",
  language: "pt_BR",
  contractHash: "abc123",
  status: "APPROVED",
};

describe("bindingState", () => {
  it("hash igual e APPROVED = ok", () => {
    expect(bindingState(SALVO, ATUAL)).toBe("ok");
    expect(isSendable("ok")).toBe(true);
  });

  it("hash divergente = stale — alguém editou o template na Meta", () => {
    // É o caso que a fase inteira persegue: o corpo ganhou um {{3}} e a config
    // salva continua mandando 2 parâmetros. Sem esta trava, só o 132000 avisa.
    expect(bindingState(SALVO, { ...ATUAL, contractHash: "def456" })).toBe("stale");
    expect(isSendable("stale")).toBe(false);
  });

  it("template sumiu da Meta = missing", () => {
    expect(bindingState(SALVO, null)).toBe("missing");
  });

  it("template pausado ou rejeitado = not_approved, mesmo com hash igual", () => {
    expect(bindingState(SALVO, { ...ATUAL, status: "PAUSED" })).toBe("not_approved");
    expect(bindingState(SALVO, { ...ATUAL, status: "REJECTED" })).toBe("not_approved");
  });

  it("PENDING também não é enviável — 'quase aprovado' não existe no disparo", () => {
    expect(bindingState(SALVO, { ...ATUAL, status: "PENDING" })).toBe("not_approved");
  });

  it("idioma diferente NÃO casa — a chave é (name, language)", () => {
    // pt_BR e pt são templates distintos na Meta, com corpos e aprovações
    // independentes. Casar só por nome resolveria para o contrato errado.
    expect(bindingState(SALVO, { ...ATUAL, language: "pt" })).toBe("missing");
  });

  it("nome diferente NÃO casa", () => {
    expect(bindingState(SALVO, { ...ATUAL, name: "outro_template" })).toBe("missing");
  });

  it("precedência: não-aprovado E hash mudado reporta not_approved, não stale", () => {
    // Mandar o operador reconfigurar parâmetros de um template que a Meta
    // recusou é fazê-lo trabalhar à toa — a recusa é o problema anterior.
    expect(
      bindingState(SALVO, { ...ATUAL, status: "REJECTED", contractHash: "def456" }),
    ).toBe("not_approved");
  });

  it("precedência: sumido vence tudo", () => {
    expect(bindingState({ ...SALVO, contractHash: "qualquer" }, null)).toBe("missing");
  });
});

describe("explainBindingState", () => {
  it("cada estado tem frase própria, nomeando o template e o próximo passo", () => {
    const estados = ["missing", "not_approved", "stale", "ok"] as const;
    const frases = estados.map((e) => explainBindingState(e, SALVO));

    // Nenhuma frase genérica: item de inbox que diz só "config inválida"
    // transfere ao operador o trabalho de descobrir o quê, e vira ruído.
    expect(new Set(frases).size).toBe(4);
    for (const f of frases) {
      expect(f).toContain("pedido_confirmado");
      expect(f).toContain("pt_BR");
    }
    expect(explainBindingState("stale", SALVO)).toMatch(/mudou na Meta/);
    expect(explainBindingState("missing", SALVO)).toMatch(/não existe mais/);
  });
});

/**
 * O binding com o hash REAL (`hashContract`), e não uma string escolhida no
 * teste: o que se prova é que uma mudança do template na Meta chega ao
 * veredito. O nó de fluxo guarda o hash no instante da escolha; o espelho
 * recalcula a cada sync.
 */
describe("bindingState com o hash real do template", () => {
  const BASE = [
    { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
    { type: "BODY", text: "Olá {{1}}, seu pedido saiu." },
    { type: "FOOTER", text: "Loja" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Confirmar" },
        { type: "QUICK_REPLY", text: "Parar mensagens" },
      ],
    },
  ];

  function veredito(depois: unknown[]) {
    const escolhido: TemplateBinding = { ...SALVO, contractHash: hashContract(BASE) };
    return bindingState(escolhido, { ...ATUAL, contractHash: hashContract(depois) });
  }
  const com = (i: number, trocar: Record<string, unknown>) =>
    BASE.map((c, j) => (j === i ? { ...c, ...trocar } : c));

  it("mesmo template, sem alteração → continua válido", () => {
    expect(veredito(structuredClone(BASE))).toBe("ok");
  });

  it("alteração de VARIÁVEL → obsoleto", () => {
    expect(veredito(com(1, { text: "Olá {{1}}, seu pedido {{2}} saiu." }))).toBe("stale");
  });

  it("alteração do CORPO → obsoleto", () => {
    expect(veredito(com(1, { text: "Oi {{1}}, seu pedido saiu!" }))).toBe("stale");
  });

  it("alteração do CABEÇALHO ou do RODAPÉ → obsoleto", () => {
    expect(veredito(com(0, { text: "Encomenda {{1}}" }))).toBe("stale");
    expect(veredito(com(2, { text: "Loja Centro" }))).toBe("stale");
  });

  it("alteração do TEXTO de um botão → obsoleto", () => {
    expect(
      veredito(com(3, { buttons: [{ type: "QUICK_REPLY", text: "Sim" }, { type: "QUICK_REPLY", text: "Parar mensagens" }] })),
    ).toBe("stale");
  });

  it("alteração da ORDEM dos botões → obsoleto (a saída button:0 mudaria de sentido)", () => {
    expect(
      veredito(com(3, { buttons: [{ type: "QUICK_REPLY", text: "Parar mensagens" }, { type: "QUICK_REPLY", text: "Confirmar" }] })),
    ).toBe("stale");
  });

  it("alteração do CONJUNTO de botões → obsoleto", () => {
    expect(veredito(com(3, { buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }] }))).toBe("stale");
  });

  it("alteração do TIPO/AÇÃO de um botão → obsoleto", () => {
    expect(
      veredito(com(3, { buttons: [{ type: "URL", text: "Confirmar", url: "https://loja.test" }, { type: "QUICK_REPLY", text: "Parar mensagens" }] })),
    ).toBe("stale");
  });

  it("alteração da ORDEM dos componentes → obsoleto", () => {
    expect(veredito([BASE[0], BASE[2], BASE[1], BASE[3]])).toBe("stale");
  });
});
