/**
 * As regras PURAS do vocabulário e dos disparos (migration 0389).
 *
 * ─── O que cada bloco vigia, e por que ele existe ──────────────────────────
 *
 * `acoesDoNo` — o nó ACTION mudou de forma (uma ação → lista). A prova que
 * importa não é que a lista funciona: é que o formato ANTIGO continua sendo
 * lido, porque há flows salvos com ele no banco de quem já está usando, e um
 * `config.actions ?? []` ingênuo transformaria esses nós em "sem ação
 * escolhida" — o flow pararia de fazer o que fazia, em silêncio, na primeira
 * vez que rodasse depois da atualização.
 *
 * `sugerirChave` — a chave do campo é IMUTÁVEL depois de criada e é o que a
 * variável da mensagem cita. Um nome que gere chave inválida ("3D Premium" →
 * "3d_premium", que o CHECK do banco recusa por começar com dígito) só seria
 * descoberto no clique de salvar, com o formulário preenchido.
 *
 * `porQueNaoPodeAgendar` — a mesma função decide o botão da tela e o 422 da
 * rota. Duplicá-la seria a tela oferecer o que o servidor recusa.
 *
 * `entradaDeDisparo` — fora da janela de 24 horas a plataforma só aceita
 * template. Mandar texto livre ali não falha aqui: falha no provedor, depois
 * de o disparo já ter sido dado como iniciado.
 */
import { describe, expect, it } from "vitest";

import { acoesDoNo } from "@/lib/flows/acoes";
import { entradaDeDisparo } from "@/lib/disparos/worker";
import { resumoDoSegmento } from "@/lib/disparos/segmento";
import { sugerirChave } from "@/lib/schemas/contact-fields";
import {
  SEGMENTO_VAZIO,
  porQueNaoPodeAgendar,
  type MensagemDeDisparo,
} from "@/lib/schemas/disparos";

describe("o nó de ações lê as duas formas de configuração", () => {
  it("a lista nova sai na ordem em que foi configurada", () => {
    const acoes = acoesDoNo({
      actions: [
        { action_type: "update_custom_field", config: { field: "produto", value: "3D" } },
        { action_type: "add_tag", config: { tags: ["ONBOARDING"] } },
      ],
    });
    expect(acoes.map((a) => a.action_type)).toEqual(["update_custom_field", "add_tag"]);
  });

  it("o formato ANTIGO (uma ação só) continua sendo lido", () => {
    // Um flow salvo antes desta fatia. Se isto parar de passar, aquele flow
    // vira "sem ação escolhida" no primeiro disparo depois da atualização.
    const acoes = acoesDoNo({ action_type: "add_tag", config: { tags: ["VIP"] } });
    expect(acoes).toEqual([{ action_type: "add_tag", config: { tags: ["VIP"] } }]);
  });

  it("a lista nova VENCE o formato antigo quando os dois estão no jsonb", () => {
    // Acontece em um nó que foi editado pela tela: ela grava `actions` e limpa
    // os campos antigos, mas um jsonb vindo de outro caminho pode ter os dois.
    const acoes = acoesDoNo({
      actions: [{ action_type: "remove_tag", config: {} }],
      action_type: "add_tag",
      config: { tags: ["VIP"] },
    });
    expect(acoes).toEqual([{ action_type: "remove_tag", config: {} }]);
  });

  it("ação sem tipo é descartada, e nó vazio devolve lista vazia", () => {
    expect(acoesDoNo({ actions: [{ action_type: "", config: {} }] })).toEqual([]);
    expect(acoesDoNo({})).toEqual([]);
  });
});

describe("a chave sugerida para um campo é sempre válida no banco", () => {
  // O CHECK é `^[a-z][a-z0-9_]{0,39}$` (migration 0389).
  const valida = /^[a-z][a-z0-9_]{0,39}$/;

  it.each([
    ["Produto de interesse", "produto_de_interesse"],
    ["Ação — Nº do Processo", "acao_n_do_processo"],
    ["UTM Content", "utm_content"],
  ])("%s → %s", (nome, esperado) => {
    expect(sugerirChave(nome)).toBe(esperado);
    expect(sugerirChave(nome)).toMatch(valida);
  });

  it("nome que começa com número ganha prefixo em vez de gerar chave inválida", () => {
    // "3D Premium" → "3d_premium" seria recusado pelo banco, e o erro só
    // apareceria no clique de salvar.
    const chave = sugerirChave("3D Premium");
    expect(chave).toMatch(valida);
    expect(chave).toBe("campo_3d_premium");
  });

  it("nome sem nenhuma letra ou número devolve vazio, e a tela pede a chave à mão", () => {
    expect(sugerirChave("—  ·  —")).toBe("");
  });

  it("a chave respeita o teto de 40 caracteres do banco", () => {
    expect(sugerirChave("a".repeat(80))).toHaveLength(40);
  });
});

describe("um disparo só é agendável quando tem público e mensagem", () => {
  const TEMPLATE: MensagemDeDisparo = {
    window_mode: "outside_24h",
    body: "",
    template_name: "reativacao",
    template_language: "pt_BR",
    template_values: {},
  };

  it("sem critério de público, recusa", () => {
    expect(porQueNaoPodeAgendar({ segment: SEGMENTO_VAZIO, message: TEMPLATE })).toMatch(/critério/);
  });

  it("só `tags_none` NÃO conta como público", () => {
    // "todo mundo menos quem tem a tag X" é o disparo para a base inteira, e
    // ninguém faz isso sem querer.
    expect(
      porQueNaoPodeAgendar({
        segment: { ...SEGMENTO_VAZIO, tags_none: ["cliente"] },
        message: TEMPLATE,
      }),
    ).toMatch(/critério/);
  });

  it("fora da janela sem template, recusa — e diz por quê", () => {
    const motivo = porQueNaoPodeAgendar({
      segment: { ...SEGMENTO_VAZIO, tags_all: ["vip"] },
      message: { ...TEMPLATE, template_name: null, template_language: null },
    });
    expect(motivo).toMatch(/template aprovado/);
  });

  it("dentro da janela sem texto, recusa", () => {
    expect(
      porQueNaoPodeAgendar({
        segment: { ...SEGMENTO_VAZIO, tags_all: ["vip"] },
        message: { window_mode: "inside_24h", body: "   ", template_values: {} },
      }),
    ).toMatch(/texto/i);
  });

  it("com público e template, libera", () => {
    expect(
      porQueNaoPodeAgendar({ segment: { ...SEGMENTO_VAZIO, tags_all: ["vip"] }, message: TEMPLATE }),
    ).toBeNull();
  });
});

describe("o payload de envio do disparo respeita a janela de 24 horas", () => {
  const CONTEXTO = { contact: { name: "Ana", custom_fields: { produto: "Impressão 3D" } } };

  it("fora da janela vira template, com as variáveis resolvidas nos espaços", () => {
    const r = entradaDeDisparo(
      {
        window_mode: "outside_24h",
        body: "",
        template_name: "reativacao",
        template_language: "pt_BR",
        template_values: { "1": "{{contact.name}}", "2": "{{contact.custom_fields.produto}}" },
      },
      "conv-1",
      CONTEXTO,
    );
    expect(r).toEqual({
      ok: true,
      input: {
        conversation_id: "conv-1",
        type: "template",
        template_name: "reativacao",
        template_language: "pt_BR",
        template_values: { "1": "Ana", "2": "Impressão 3D" },
      },
    });
  });

  it("fora da janela SEM template é recusado aqui, não no provedor", () => {
    const r = entradaDeDisparo(
      { window_mode: "outside_24h", body: "Oi", template_values: {} },
      "conv-1",
      CONTEXTO,
    );
    expect(r).toEqual({ ok: false, error: "template_incompleto" });
  });

  it("dentro da janela vira texto com as variáveis resolvidas", () => {
    const r = entradaDeDisparo(
      { window_mode: "inside_24h", body: "Oi {{contact.name}}", template_values: {} },
      "conv-1",
      CONTEXTO,
    );
    expect(r).toEqual({ ok: true, input: { conversation_id: "conv-1", type: "text", body: "Oi Ana" } });
  });

  it("variável que não existe vira vazio, e o corpo só de variáveis é recusado", () => {
    // Sem esta recusa sairia uma mensagem em branco para a base inteira.
    const r = entradaDeDisparo(
      { window_mode: "inside_24h", body: "{{contact.custom_fields.inexistente}}", template_values: {} },
      "conv-1",
      CONTEXTO,
    );
    expect(r).toEqual({ ok: false, error: "missing_body" });
  });
});

describe("o resumo do segmento descreve o filtro em uma frase", () => {
  it("diz quando não há critério nenhum", () => {
    expect(resumoDoSegmento(SEGMENTO_VAZIO)).toMatch(/não tem público/);
    expect(resumoDoSegmento(null)).toMatch(/não tem público/);
  });

  it("junta tags e campos", () => {
    expect(
      resumoDoSegmento({
        tags_all: ["cliente"],
        tags_any: ["vip", "ouro"],
        tags_none: ["cancelado"],
        fields: [
          { key: "produto", op: "eq", value: "3D" },
          { key: "origem", op: "set", value: "" },
        ],
      }),
    ).toBe("com cliente, com vip ou ouro, sem cancelado, produto = 3D, origem preenchido");
  });
});
