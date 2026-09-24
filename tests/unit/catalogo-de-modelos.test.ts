import { describe, expect, it } from "vitest";

import {
  conexoesComModelos,
  escopoDaConexao,
  listarModelos,
  modeloDaLinha,
  resolverModelo,
  type LinhaDoCatalogo,
} from "@/lib/channels/catalogo-de-modelos";
import { slotKey } from "@/lib/channels/meta/build-components";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import {
  acharModeloNoCatalogo,
  configDoModeloEscolhido,
  respostasRapidas,
} from "@/hooks/channels/useCatalogoDeModelos";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * O CATÁLOGO CENTRAL DE MODELOS — uma leitura só para Conexões, Fluxos e,
 * depois, Disparos.
 *
 * O que está sob prova:
 *   1. a FORMA sai das funções do envio (`deriveTemplateContract`, `slotKey`) —
 *      os espaços que a tela pede são exatamente os que o envio vai cobrar;
 *   2. o RECORTE: organização sempre, conta da conexão quando pedida, e
 *      conexão de outra organização devolve NADA (nunca "a organização toda");
 *   3. a ESCOLHA grava referência + retrato, e o nó antigo continua resolvido.
 */

const ORG_A = "org-a";
const ORG_B = "org-b";
const SESSAO_A = "11111111-1111-4111-8111-111111111111";
const SESSAO_A2 = "22222222-2222-4222-8222-222222222222";
const SESSAO_B = "33333333-3333-4333-8333-333333333333";
const WABA_A = "1573740213843141";

const COMPONENTES = [
  { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
  { type: "BODY", text: "Olá {{1}}, seu pedido saiu em {{2}}." },
  { type: "FOOTER", text: "Responda para falar com a gente" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirmar" },
      { type: "QUICK_REPLY", text: "Parar mensagens" },
      { type: "URL", text: "Rastrear", url: "https://loja.test/r/{{1}}" },
    ],
  },
];

function linha(parcial: Partial<LinhaDoCatalogo> & { organization_id?: string }): LinhaDoCatalogo & {
  organization_id: string;
} {
  return {
    id: parcial.id ?? `tpl-${Math.random().toString(36).slice(2)}`,
    organization_id: parcial.organization_id ?? ORG_A,
    waba_id: parcial.waba_id ?? WABA_A,
    channel_session_id: parcial.channel_session_id ?? null,
    name: parcial.name ?? "pedido_enviado",
    language: parcial.language ?? "pt_BR",
    status: parcial.status ?? "APPROVED",
    category: parcial.category ?? "UTILITY",
    rejected_reason: parcial.rejected_reason ?? null,
    quality_score: null,
    parameter_format: "POSITIONAL",
    contract_hash: parcial.contract_hash ?? "hash-1",
    components: parcial.components ?? COMPONENTES,
    synced_at: "2026-09-23T10:00:00Z",
    saved_values: parcial.saved_values ?? {},
  };
}

function bancoComDuasOrganizacoes() {
  return criarBanco({
    channel_sessions: [
      { id: SESSAO_A, organization_id: ORG_A, provider: "meta_cloud", display_name: "Loja", phone_number: "+55 11 9", meta_waba_id: WABA_A, archived_at: null, created_at: "1" },
      { id: SESSAO_A2, organization_id: ORG_A, provider: "meta_cloud", display_name: null, phone_number: "+55 11 8", meta_waba_id: "999", archived_at: null, created_at: "2" },
      // WAHA não tem catálogo de modelos: não entra na lista de conexões.
      { id: "waha-a", organization_id: ORG_A, provider: "waha", display_name: "QR", phone_number: null, meta_waba_id: null, archived_at: null, created_at: "3" },
      { id: SESSAO_B, organization_id: ORG_B, provider: "meta_cloud", display_name: "Outra", phone_number: null, meta_waba_id: WABA_A, archived_at: null, created_at: "1" },
    ],
    meta_templates: [
      linha({ id: "a-aprovado", name: "pedido_enviado" }),
      linha({ id: "a-pausado", name: "promo", status: "PAUSED" }),
      linha({ id: "a-outra-conta", name: "so_na_outra", waba_id: "999", channel_session_id: null }),
      linha({ id: "a-da-sessao-2", name: "da_sessao_2", channel_session_id: SESSAO_A2, waba_id: "999" }),
      linha({ id: "b-aprovado", organization_id: ORG_B, name: "segredo_de_b" }),
    ],
  });
}

describe("a forma do modelo sai das funções do ENVIO", () => {
  it("espaços com a chave de `slotKey`, conteúdo e botões como a plataforma declarou", () => {
    const m = modeloDaLinha(linha({ id: "x" }));
    const contrato = deriveTemplateContract({ name: "pedido_enviado", language: "pt_BR", components: COMPONENTES });
    // A lista de chaves é a do CONTRATO do envio — não uma recontagem da tela.
    expect(m.espacos.map((e) => e.valueKey)).toEqual(contrato.slots.map((s) => slotKey(s.address, s.key)));
    expect(m.espacos.map((e) => e.valueKey)).toEqual(["header:1", "1", "2", "button2:1"]);
    expect(m.conteudo.header).toEqual({ formato: "TEXT", texto: "Pedido {{1}}" });
    expect(m.conteudo.body).toBe("Olá {{1}}, seu pedido saiu em {{2}}.");
    expect(m.conteudo.footer).toBe("Responda para falar com a gente");
    expect(m.conteudo.botoes.map((b) => b.tipo)).toEqual(["QUICK_REPLY", "QUICK_REPLY", "URL"]);
    expect(m.utilizavel).toBe(true);
  });

  it("só APROVADO é utilizável — a mesma régua do envio", () => {
    for (const status of ["PENDING", "PAUSED", "REJECTED", "DISABLED", "IN_APPEAL"]) {
      expect(modeloDaLinha(linha({ status })).utilizavel).toBe(false);
    }
  });

  it("só respostas rápidas viram saída — botão de URL abre algo e não volta", () => {
    expect(respostasRapidas(modeloDaLinha(linha({})))).toEqual(["Confirmar", "Parar mensagens"]);
  });
});

describe("o recorte por organização e por conexão", () => {
  it("a organização A nunca recebe modelo da B", async () => {
    const banco = bancoComDuasOrganizacoes();
    const modelos = await listarModelos(banco.client, { organizationId: ORG_A });
    expect(modelos.map((m) => m.id)).not.toContain("b-aprovado");
    expect(modelos).toHaveLength(4);
  });

  it("somenteUtilizaveis tira o pausado", async () => {
    const banco = bancoComDuasOrganizacoes();
    const ids = (await listarModelos(banco.client, { organizationId: ORG_A, somenteUtilizaveis: true })).map((m) => m.id);
    expect(ids).not.toContain("a-pausado");
    expect(ids).toContain("a-aprovado");
  });

  it("com conexão: só a conta dela — linha sem conexão entra pela conta, a de outra conexão não", async () => {
    const banco = bancoComDuasOrganizacoes();
    const ids = (await listarModelos(banco.client, { organizationId: ORG_A, channelSessionId: SESSAO_A })).map((m) => m.id);
    expect(ids.sort()).toEqual(["a-aprovado", "a-pausado"]);

    const daSessao2 = (await listarModelos(banco.client, { organizationId: ORG_A, channelSessionId: SESSAO_A2 })).map((m) => m.id);
    expect(daSessao2.sort()).toEqual(["a-da-sessao-2", "a-outra-conta"]);
  });

  it("conexão de OUTRA organização devolve lista vazia — nunca a organização inteira", async () => {
    const banco = bancoComDuasOrganizacoes();
    expect(await listarModelos(banco.client, { organizationId: ORG_A, channelSessionId: SESSAO_B })).toEqual([]);
  });

  it("as conexões oferecidas são só as da organização e só as que têm catálogo", async () => {
    const banco = bancoComDuasOrganizacoes();
    const conexoes = await conexoesComModelos(banco.client, ORG_A);
    expect(conexoes.map((c) => c.id)).toEqual([SESSAO_A, SESSAO_A2]);
    expect(conexoes[0]!.rotulo).toBe("Loja");
  });

  it("o id da conta só entra no filtro se for número — é texto interpolado numa expressão", () => {
    expect(escopoDaConexao({ id: "s1", meta_waba_id: "123" })).toBe(
      "channel_session_id.eq.s1,and(channel_session_id.is.null,waba_id.eq.123)",
    );
    expect(escopoDaConexao({ id: "s1", meta_waba_id: "1),or(organization_id.neq.x" })).toBe("channel_session_id.eq.s1");
  });
});

describe("resolver a referência de uma configuração", () => {
  it("pelo id — e o id de OUTRA organização não resolve", async () => {
    const banco = bancoComDuasOrganizacoes();
    expect((await resolverModelo(banco.client, ORG_A, { templateId: "a-aprovado" }))?.name).toBe("pedido_enviado");
    expect(await resolverModelo(banco.client, ORG_A, { templateId: "b-aprovado" })).toBeNull();
  });

  it("pelo id COM a conexão do nó: o modelo tem de ser da conta que envia", async () => {
    const banco = bancoComDuasOrganizacoes();
    // Modelo da conta da sessão A, enviado pela sessão A: resolve.
    expect((await resolverModelo(banco.client, ORG_A, { templateId: "a-aprovado", channelSessionId: SESSAO_A }))?.id).toBe(
      "a-aprovado",
    );
    // O MESMO modelo com a conexão A2 (outra conta): não resolve — o envio sairia
    // por um número que não tem esse modelo aprovado.
    expect(await resolverModelo(banco.client, ORG_A, { templateId: "a-aprovado", channelSessionId: SESSAO_A2 })).toBeNull();
    // Conexão de OUTRA organização: não resolve.
    expect(await resolverModelo(banco.client, ORG_A, { templateId: "a-aprovado", channelSessionId: SESSAO_B })).toBeNull();
    // Conexão arquivada: não resolve.
    banco.tabelas.channel_sessions!.find((c) => c.id === SESSAO_A)!.archived_at = "2026-09-23";
    expect(await resolverModelo(banco.client, ORG_A, { templateId: "a-aprovado", channelSessionId: SESSAO_A })).toBeNull();
  });

  it("nó ANTIGO (só nome e idioma) resolve pelo par, recortado pela conexão", async () => {
    const banco = bancoComDuasOrganizacoes();
    expect(
      (await resolverModelo(banco.client, ORG_A, { name: "pedido_enviado", language: "pt_BR" }))?.id,
    ).toBe("a-aprovado");
    // Outro idioma é OUTRO modelo na plataforma.
    expect(await resolverModelo(banco.client, ORG_A, { name: "pedido_enviado", language: "pt" })).toBeNull();
    // O par existe, mas em outra conta: pela conexão da sessão 2, não resolve.
    expect(
      await resolverModelo(banco.client, ORG_A, { name: "pedido_enviado", language: "pt_BR", channelSessionId: SESSAO_A2 }),
    ).toBeNull();
  });
});

describe("a escolha no nó grava referência + retrato", () => {
  const modelo = modeloDaLinha(
    linha({ id: "a-aprovado", contract_hash: "hash-v1", saved_values: { "header:1": "ignorado-por-nao-ser-midia" } }),
  );

  it("template_id, nome, idioma, contract_hash e a conexão", () => {
    const cfg = configDoModeloEscolhido(modelo, SESSAO_A, {});
    expect(cfg).toMatchObject({
      template_id: "a-aprovado",
      template_name: "pedido_enviado",
      template_language: "pt_BR",
      template_contract_hash: "hash-v1",
      channel_session_id: SESSAO_A,
    });
  });

  it("os valores ficam com EXATAMENTE as chaves do contrato; o que já estava na mesma chave fica", () => {
    const cfg = configDoModeloEscolhido(modelo, SESSAO_A, { "1": "{{contact.name}}", antiga: "sai" });
    expect(cfg.template_values).toEqual({ "header:1": "", "1": "{{contact.name}}", "2": "", "button2:1": "" });
  });

  it("as respostas rápidas viram os botões (saídas) do nó, na ordem do modelo", () => {
    expect(configDoModeloEscolhido(modelo, SESSAO_A, {}).buttons).toEqual([
      { label: "Confirmar" },
      { label: "Parar mensagens" },
    ]);
  });

  it("no catálogo carregado: acha pelo id, e o nó antigo pelo par da mesma conta", () => {
    const catalogo = {
      conexoes: [{ id: SESSAO_A, rotulo: "Loja", wabaId: WABA_A }],
      modelos: [modelo],
    };
    expect(acharModeloNoCatalogo(catalogo, { template_id: "a-aprovado" })?.id).toBe("a-aprovado");
    expect(
      acharModeloNoCatalogo(catalogo, { template_name: "pedido_enviado", template_language: "pt_BR" })?.id,
    ).toBe("a-aprovado");
    expect(
      acharModeloNoCatalogo(catalogo, { template_name: "pedido_enviado", template_language: "pt_BR", channel_session_id: SESSAO_A })?.id,
    ).toBe("a-aprovado");
    expect(acharModeloNoCatalogo(catalogo, { template_name: "nao_existe", template_language: "pt_BR" })).toBeNull();
  });
});
