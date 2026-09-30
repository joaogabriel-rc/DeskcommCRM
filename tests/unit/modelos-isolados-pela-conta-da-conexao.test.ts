import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dublados: a REDE (fetch) e o PAPEL de quem chama. Conexão, catálogo, espelho e
// sincronização são de verdade, sobre um banco que APLICA cada filtro.
const admin = vi.hoisted(() => ({ db: {} as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.db }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

import { GET } from "@/app/api/v1/channels/templates/route";
import { requireRole } from "@/lib/auth/require-role";
import { escopoDasConexoes, listarModelos } from "@/lib/channels/catalogo-de-modelos";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * O MODELO É DA CONTA DA CONEXÃO — trocar de número não arrasta a lista antiga.
 *
 * O relato: conectou um número de TESTE, aprovou modelos nele, desconectou,
 * conectou o número DEFINITIVO — e os modelos do teste seguiam na lista, mesmo
 * depois de "Sincronizar".
 *
 * As duas causas, medidas:
 *   1. A tela de Modelos lia `meta_templates` da ORGANIZAÇÃO INTEIRA, sem recorte
 *      por conexão ativa. O sync só escreve na conta atual e nunca toca na linha
 *      da conta anterior — por isso "Sincronizar" não resolvia.
 *   2. O canal oficial é UMA linha de sessão por organização, e conectar outro
 *      número a REAPROVEITA trocando `meta_waba_id`. O recorte por conexão
 *      aceitava `channel_session_id = sessão` sem olhar a conta, então o modelo
 *      criado pelo CRM na conta de teste (que carrega o id da sessão) casava com
 *      a conexão nova.
 *
 * O conserto não apaga nada: as linhas ficam no banco, só deixam de ser
 * oferecidas. Reconectar a MESMA conta as mostra de novo, sem duplicar.
 *
 * Sabotagem medida: voltar `escopoDaConexao` a aceitar `channel_session_id` sem a
 * conta deixa vermelho o caso ⭐ da conta trocada.
 */

const ORG_A = "0400aaaa-0000-4000-8000-000000000001";
const ORG_B = "0400bbbb-0000-4000-8000-000000000002";
const SESSAO = "0400aaaa-5555-4000-8000-000000000001";
const SESSAO_B = "0400bbbb-5555-4000-8000-000000000001";
const CONTA_TESTE = "1110000000001";
const CONTA_DEFINITIVA = "2220000000002";

function modelo(o: Record<string, unknown>) {
  return {
    organization_id: ORG_A,
    channel_session_id: null,
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    rejected_reason: null,
    quality_score: null,
    parameter_format: "POSITIONAL",
    contract_hash: "h",
    components: [{ type: "BODY", text: "Oi" }],
    synced_at: "2026-09-20T00:00:00Z",
    saved_values: {},
    ...o,
  };
}

let banco: BancoEmMemoria;

function montar(contaAtual: string | null, arquivada = false, status = "WORKING") {
  banco = criarBanco({
    channel_sessions: [
      {
        id: SESSAO,
        organization_id: ORG_A,
        provider: "meta_cloud",
        display_name: "Loja",
        phone_number: "+55 11 9",
        meta_waba_id: contaAtual,
        meta_phone_number_id: "900111",
        status,
        archived_at: arquivada ? "2026-09-25" : null,
        created_at: "1",
      },
      {
        id: SESSAO_B,
        organization_id: ORG_B,
        provider: "meta_cloud",
        display_name: "Outra",
        phone_number: null,
        meta_waba_id: CONTA_DEFINITIVA,
        meta_phone_number_id: "900222",
        archived_at: null,
        created_at: "1",
      },
    ],
    meta_templates: [
      // Sincronizados da conta de TESTE (sem sessão, como o sync grava).
      modelo({ id: "t-sync", waba_id: CONTA_TESTE, name: "boas_vindas_teste" }),
      // Criado PELO CRM na conta de teste — carrega o id da sessão (G1).
      modelo({ id: "t-criado", waba_id: CONTA_TESTE, channel_session_id: SESSAO, name: "promo_teste" }),
      // Da conta DEFINITIVA.
      modelo({ id: "d-sync", waba_id: CONTA_DEFINITIVA, name: "pedido_confirmado" }),
      // Outra organização, mesma conta definitiva: nunca vaza para a A.
      modelo({ id: "b-sync", organization_id: ORG_B, waba_id: CONTA_DEFINITIVA, name: "segredo_de_b" }),
    ],
  });
  admin.db = banco.client;
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function nomesDaTela(): Promise<string[]> {
  const res = await GET();
  const corpo = (await res.json()) as { data: { templates: Array<{ name: string }> } };
  return corpo.data.templates.map((t) => t.name).sort();
}

describe("a tela de Modelos mostra só a conta da conexão ATIVA", () => {
  it("⭐ trocou a conta: nem o sincronizado nem o criado pelo CRM na conta de teste aparecem", async () => {
    montar(CONTA_DEFINITIVA);
    expect(await nomesDaTela()).toEqual(["pedido_confirmado"]);
  });

  it("CONTROLE: com a conta de teste conectada, os dois dela aparecem (e o definitivo não)", async () => {
    montar(CONTA_TESTE);
    expect(await nomesDaTela()).toEqual(["boas_vindas_teste", "promo_teste"]);
  });

  it("conexão excluída (arquivada): nenhum modelo — nunca a organização inteira", async () => {
    montar(CONTA_TESTE, true);
    expect(await nomesDaTela()).toEqual([]);
  });

  it("os modelos de outra organização na MESMA conta nunca aparecem", async () => {
    montar(CONTA_DEFINITIVA);
    expect(await nomesDaTela()).not.toContain("segredo_de_b");
  });

  it("nada é apagado: as linhas da conta anterior continuam no banco", async () => {
    montar(CONTA_DEFINITIVA);
    await nomesDaTela();
    expect(banco.tabelas.meta_templates!.map((m) => m.id).sort()).toEqual(["b-sync", "d-sync", "t-criado", "t-sync"]);
  });
});

describe("o catálogo central (Fluxos e Disparos) segue a mesma régua", () => {
  it("sem conexão escolhida: só as contas das conexões ativas", async () => {
    montar(CONTA_DEFINITIVA);
    const nomes = (await listarModelos(banco.client as never, { organizationId: ORG_A })).map((m) => m.name);
    expect(nomes).toEqual(["pedido_confirmado"]);
  });

  it("com a conexão escolhida: a conta ATUAL dela, e não o que carrega o id da sessão", async () => {
    montar(CONTA_DEFINITIVA);
    const nomes = (await listarModelos(banco.client as never, { organizationId: ORG_A, channelSessionId: SESSAO })).map(
      (m) => m.name,
    );
    expect(nomes).toEqual(["pedido_confirmado"]);
  });

  it("sem conexão ativa nenhuma, o recorte é vazio (null) — e a leitura devolve lista vazia", async () => {
    expect(escopoDasConexoes([])).toBeNull();
    montar(CONTA_TESTE, true);
    expect(await listarModelos(banco.client as never, { organizationId: ORG_A })).toEqual([]);
  });
});

describe("reconectar a MESMA conta não duplica", () => {
  it("sincronizar duas vezes a mesma conta mantém uma linha por (conta, nome, idioma)", async () => {
    montar(CONTA_DEFINITIVA);
    const resposta = {
      data: [
        { name: "pedido_confirmado", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: [] },
        { name: "novo_da_conta", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: [] },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(resposta), { status: 200 })),
    );
    const entrada = { organizationId: ORG_A, wabaId: CONTA_DEFINITIVA, token: "tok", graphVersion: "v22.0" };
    await syncTemplates(entrada);
    await syncTemplates(entrada);

    const daConta = banco.tabelas.meta_templates!.filter(
      (m) => m.organization_id === ORG_A && m.waba_id === CONTA_DEFINITIVA,
    );
    expect(daConta.map((m) => m.name).sort()).toEqual(["novo_da_conta", "pedido_confirmado"]);
    // A conta de teste ficou intocada pelo sync da conta definitiva.
    expect(banco.tabelas.meta_templates!.filter((m) => m.waba_id === CONTA_TESTE)).toHaveLength(2);
  });
});

/**
 * O ESTADO DA CONEXÃO decide também: parada pela Meta (`STOPPED`), os modelos
 * dela saem da lista na hora — sem apagar nada — e voltam com a reconexão.
 *
 * Sabotagem medida: tirar `.filter((c) => !conexaoParada(c))` de
 * `conexoesComModelos` deixa vermelho o caso ⭐.
 */
describe("o estado da conexão: STOPPED esconde, WORKING mostra", () => {
  it("WORKING: os modelos da conta atual aparecem", async () => {
    montar(CONTA_DEFINITIVA, false, "WORKING");
    expect(await nomesDaTela()).toEqual(["pedido_confirmado"]);
  });

  it("⭐ STOPPED (desconectada pela Meta): nenhum modelo dela na tela nem no catálogo — e nada foi apagado", async () => {
    montar(CONTA_DEFINITIVA, false, "STOPPED");
    expect(await nomesDaTela()).toEqual([]);
    expect(await listarModelos(banco.client as never, { organizationId: ORG_A })).toEqual([]);
    expect(await listarModelos(banco.client as never, { organizationId: ORG_A, channelSessionId: SESSAO })).toEqual([]);
    expect(banco.tabelas.meta_templates!).toHaveLength(4);
  });

  it("reconectar a MESMA conta (STOPPED → WORKING): os modelos voltam, sem duplicar", async () => {
    montar(CONTA_DEFINITIVA, false, "STOPPED");
    expect(await nomesDaTela()).toEqual([]);
    banco.tabelas.channel_sessions!.find((s) => s.id === SESSAO)!.status = "WORKING";
    expect(await nomesDaTela()).toEqual(["pedido_confirmado"]);
    expect(banco.tabelas.meta_templates!.filter((m) => m.name === "pedido_confirmado" && m.organization_id === ORG_A)).toHaveLength(1);
  });

  it("parada na conta de teste e reconectada em OUTRA conta: só os da conta nova aparecem", async () => {
    montar(CONTA_TESTE, false, "STOPPED");
    expect(await nomesDaTela()).toEqual([]);
    const s = banco.tabelas.channel_sessions!.find((x) => x.id === SESSAO)!;
    s.meta_waba_id = CONTA_DEFINITIVA;
    s.status = "WORKING";
    expect(await nomesDaTela()).toEqual(["pedido_confirmado"]);
  });

  it("a parada de UMA organização não esconde os modelos da outra na mesma conta", async () => {
    montar(CONTA_DEFINITIVA, false, "STOPPED");
    const b = await listarModelos(banco.client as never, { organizationId: ORG_B });
    expect(b.map((m) => m.name)).toEqual(["segredo_de_b"]);
  });
});
