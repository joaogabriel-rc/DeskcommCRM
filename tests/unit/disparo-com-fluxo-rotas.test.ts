import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * DISPARO "MODO FLUXO" PELAS ROTAS — o fluxo é do disparo, nasce com ele, não
 * aparece em Automações, não liga por fora, e agendar confere o fluxo inteiro e
 * abre a permissão de cada contato no número dos modelos.
 *
 * Rotas de verdade; banco dublê que aplica filtro (tests/helpers/banco-em-memoria.ts).
 * A coerência que o BANCO garante (FK composta, `flows_disparo_coerente`, o
 * trigger da execução) está provada em tests/invariants/disparo-com-fluxo.test.ts.
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  role: vi.fn(),
  audit: vi.fn(),
  materializacoes: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.client }));

import { POST as criarDisparo } from "@/app/api/v1/broadcasts/route";
import { GET as lerDisparo, PATCH as mudarDisparo } from "@/app/api/v1/broadcasts/[id]/route";
import { GET as listarFluxos } from "@/app/api/v1/flows/route";
import { DELETE as apagarFluxo, PATCH as mudarFluxo } from "@/app/api/v1/flows/[id]/route";
import { PUT as salvarGrafo } from "@/app/api/v1/flows/[id]/graph/route";
import { hashContract } from "@/lib/channels/meta/contract-hash";

const ORG = "org-a";
const SESSAO = "11111111-1111-4111-8111-111111111111";
const SESSAO_B = "22222222-2222-4222-8222-222222222222";
const MODELO = [{ type: "BODY", text: "Olá {{1}}" }];
const TPL = "33333333-3333-4333-8333-333333333333";

const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://crm.test${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const corpo = async (r: Response) => (await r.json()) as { data: Record<string, unknown>; error?: { message: string } };

beforeEach(() => {
  vi.clearAllMocks();
  h.materializacoes = [];
  h.banco = criarBanco(
    {
      broadcasts: [],
      flows: [{ id: "fluxo-comum", organization_id: ORG, name: "Boas-vindas", trigger_type: "contact_tag_added", broadcast_id: null, status: "draft" }],
      flow_nodes: [],
      flow_edges: [],
      contacts: [
        { id: "c1", organization_id: ORG, is_blocked: false, is_anonymized: false, is_merged_into: null, phone_number: "+551", tags: ["vip"], custom_fields: {}, created_at: "1" },
        { id: "c2", organization_id: "org-b", is_blocked: false, is_anonymized: false, is_merged_into: null, phone_number: "+552", tags: ["vip"], custom_fields: {}, created_at: "2" },
      ],
      channel_sessions: [
        { id: SESSAO, organization_id: ORG, provider: "meta_cloud", meta_waba_id: "123", archived_at: null, created_at: "1" },
        { id: SESSAO_B, organization_id: ORG, provider: "meta_cloud", meta_waba_id: "456", archived_at: null, created_at: "2" },
      ],
      meta_templates: [
        {
          id: TPL, organization_id: ORG, waba_id: "123", channel_session_id: null, name: "boas", language: "pt_BR",
          status: "APPROVED", category: "UTILITY", rejected_reason: null, quality_score: null, parameter_format: "POSITIONAL",
          contract_hash: hashContract(MODELO), components: MODELO, synced_at: "x", saved_values: {},
        },
      ],
    },
    {
      fn_broadcast_materializar: (args) => {
        h.materializacoes.push(args);
        return { inseridos: (args.p_contact_ids as string[]).length, pulados: 0 };
      },
      fn_flow_replace_graph: (args) => {
        h.banco.tabelas.flow_nodes = (h.banco.tabelas.flow_nodes ?? []).filter((n) => n.flow_id !== args.p_flow_id);
        for (const n of args.p_nodes as Array<Record<string, unknown>>) {
          h.banco.tabelas.flow_nodes.push({ ...n, organization_id: args.p_organization_id, flow_id: args.p_flow_id });
        }
        return null;
      },
    },
    {
      broadcasts: { status: "draft", segment: {}, message: {}, total_recipients: 0, sent_count: 0, failed_count: 0, skipped_count: 0 },
      flows: { status: "draft", version: 1, trigger_config: {} },
    },
  );
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u-1", idioma: "pt-BR" } });
});

async function disparoComFluxo(): Promise<{ id: string; fluxoId: string }> {
  const r = await criarDisparo(
    req("/api/v1/broadcasts", "POST", { name: "Black Friday", modo: "fluxo", segment: { tags_all: ["vip"] } }),
  );
  expect(r.status).toBe(201);
  const { data } = await corpo(r);
  return { id: data.id as string, fluxoId: (data.fluxo as { id: string }).id };
}

function passoDeMensagem(fluxoId: string, cfg: Record<string, unknown>) {
  const gatilho = h.banco.tabelas.flow_nodes!.find((n) => n.flow_id === fluxoId && n.type === "TRIGGER")!;
  h.banco.tabelas.flow_nodes!.push({ id: "msg", organization_id: ORG, flow_id: fluxoId, type: "MESSAGE", label: "Oferta", config: cfg });
  h.banco.tabelas.flow_edges!.push({ id: "e", organization_id: ORG, flow_id: fluxoId, source_node_id: gatilho.id, target_node_id: "msg" });
}

const MENSAGEM_OK = {
  window_mode: "outside_24h",
  template_id: TPL,
  template_name: "boas",
  template_language: "pt_BR",
  template_contract_hash: hashContract(MODELO),
  template_values: { "1": "{{contact.name}}" },
  channel_session_id: SESSAO,
};

describe("o disparo modo fluxo nasce com o fluxo PRÓPRIO dele", () => {
  it("POST modo=fluxo cria o fluxo com broadcast_id, gatilho broadcast e o nó Quando…", async () => {
    const { id, fluxoId } = await disparoComFluxo();
    const fluxo = h.banco.tabelas.flows!.find((f) => f.id === fluxoId)!;
    expect(fluxo).toMatchObject({ organization_id: ORG, broadcast_id: id, trigger_type: "broadcast" });
    const nos = h.banco.tabelas.flow_nodes!.filter((n) => n.flow_id === fluxoId);
    expect(nos).toEqual([expect.objectContaining({ type: "TRIGGER", config: { trigger_type: "broadcast", config: {} } })]);
    const lido = await corpo(await lerDisparo(req(`/api/v1/broadcasts/${id}`, "GET"), params(id)));
    expect(lido.data).toMatchObject({ modo: "fluxo", fluxo: { id: fluxoId } });
  });

  it("o fluxo do disparo NÃO aparece na lista de Automações", async () => {
    const { fluxoId } = await disparoComFluxo();
    const lista = (await corpo(await listarFluxos())).data as unknown as Array<{ id: string }>;
    expect(lista.map((f) => f.id)).toEqual(["fluxo-comum"]);
    expect(lista.map((f) => f.id)).not.toContain(fluxoId);
  });

  it("não liga, não troca de gatilho e não é apagado pela rota comum de fluxos", async () => {
    const { fluxoId } = await disparoComFluxo();
    expect((await mudarFluxo(req(`/api/v1/flows/${fluxoId}`, "PATCH", { status: "active" }), params(fluxoId))).status).toBe(409);
    expect((await apagarFluxo(req(`/api/v1/flows/${fluxoId}`, "DELETE"), params(fluxoId))).status).toBe(409);
    expect(h.banco.tabelas.flows!.find((f) => f.id === fluxoId)).toMatchObject({ status: "draft" });
  });

  it("o canvas mantém o gatilho broadcast; um fluxo COMUM não o recebe", async () => {
    const { fluxoId } = await disparoComFluxo();
    const gatilho = h.banco.tabelas.flow_nodes!.find((n) => n.flow_id === fluxoId)!;
    const tentativa = {
      nodes: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", type: "TRIGGER", label: "", config: { trigger_type: "contact_tag_added", config: { tag: "x" } }, position_x: 0, position_y: 0 }],
      edges: [],
    };
    void gatilho;
    expect((await salvarGrafo(req(`/api/v1/flows/${fluxoId}/graph`, "PUT", tentativa), params(fluxoId))).status).toBe(200);
    expect(h.banco.tabelas.flows!.find((f) => f.id === fluxoId)).toMatchObject({ trigger_type: "broadcast" });

    const intruso = { ...tentativa, nodes: [{ ...tentativa.nodes[0]!, config: { trigger_type: "broadcast", config: {} } }] };
    expect((await salvarGrafo(req(`/api/v1/flows/fluxo-comum/graph`, "PUT", intruso), params("fluxo-comum"))).status).toBe(422);
  });

  it("trocar para guiado (rascunho) apaga o fluxo do disparo", async () => {
    const { id, fluxoId } = await disparoComFluxo();
    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { modo: "guiado" }), params(id));
    expect(r.status).toBe(200);
    expect(h.banco.tabelas.flows!.find((f) => f.id === fluxoId)).toBeUndefined();
    expect((await corpo(r)).data).toMatchObject({ modo: "guiado", fluxo: null });
  });
});

describe("agendar o disparo com fluxo", () => {
  it("fluxo só com o gatilho: recusa dizendo o que falta", async () => {
    const { id } = await disparoComFluxo();
    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { acao: "agendar" }), params(id));
    expect(r.status).toBe(422);
    expect((await corpo(r)).error?.message).toMatch(/só tem o gatilho/);
    expect(h.materializacoes).toHaveLength(0);
  });

  it("modelo de OUTRA conta com o número do passo: recusa — o envio sairia pelo número errado", async () => {
    const { id, fluxoId } = await disparoComFluxo();
    passoDeMensagem(fluxoId, { ...MENSAGEM_OK, channel_session_id: SESSAO_B });
    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { acao: "agendar" }), params(id));
    expect(r.status).toBe(422);
    expect((await corpo(r)).error?.message).toMatch(/não foi localizado/);
  });

  it("fluxo válido: materializa SÓ o público da organização, NO número dos modelos, e liga o fluxo", async () => {
    const { id, fluxoId } = await disparoComFluxo();
    passoDeMensagem(fluxoId, MENSAGEM_OK);
    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { acao: "agendar" }), params(id));
    expect(r.status).toBe(200);
    expect(h.materializacoes).toEqual([{ p_broadcast: id, p_org: ORG, p_contact_ids: ["c1"], p_session: SESSAO }]);
    expect(h.banco.tabelas.flows!.find((f) => f.id === fluxoId)).toMatchObject({ status: "active" });
    expect(h.banco.tabelas.broadcasts!.find((b) => b.id === id)).toMatchObject({ status: "scheduled" });
  });

  it("guiado com modelo do catálogo: materializa no número do modelo", async () => {
    const r0 = await criarDisparo(
      req("/api/v1/broadcasts", "POST", { name: "Aviso", segment: { tags_all: ["vip"] }, message: MENSAGEM_OK }),
    );
    const id = (await corpo(r0)).data.id as string;
    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { acao: "agendar" }), params(id));
    expect(r.status).toBe(200);
    expect(h.materializacoes[0]).toMatchObject({ p_session: SESSAO, p_contact_ids: ["c1"] });
    expect(h.banco.tabelas.flows!.some((f) => f.broadcast_id === id)).toBe(false);
  });
});

describe("isolamento", () => {
  it("o disparo de OUTRA organização não é lido nem agendado", async () => {
    h.banco.tabelas.broadcasts!.push({ id: "b-da-b", organization_id: "org-b", name: "x", status: "draft", segment: { tags_all: ["vip"] }, message: {} });
    expect((await lerDisparo(req("/api/v1/broadcasts/b-da-b", "GET"), params("b-da-b"))).status).toBe(404);
    expect((await mudarDisparo(req("/api/v1/broadcasts/b-da-b", "PATCH", { acao: "agendar" }), params("b-da-b"))).status).toBe(404);
    expect(h.materializacoes).toHaveLength(0);
  });
});
