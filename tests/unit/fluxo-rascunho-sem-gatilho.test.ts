import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * "NOVO FLUXO" ABRE DIRETO NO CONSTRUTOR, E O GATILHO É ESCOLHIDO LÁ DENTRO.
 *
 * O fluxo nasce rascunho SEM gatilho (migration 0393: `trigger_type` nulo) e
 * pode ser salvo assim quantas vezes for — montar o desenho antes de decidir o
 * que o inicia é o normal. O que continua barrado é LIGAR: um fluxo sem gatilho
 * nunca colocaria ninguém dentro, e o motor só lê fluxos `active`.
 *
 * As três rotas são as de verdade; o banco é o dublê que aplica filtros.
 */

const h = vi.hoisted(() => ({ banco: null as unknown as BancoEmMemoria, role: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.client }));

import { POST as criarFluxo } from "@/app/api/v1/flows/route";
import { PUT as salvarGrafo } from "@/app/api/v1/flows/[id]/graph/route";
import { PATCH as atualizarFluxo } from "@/app/api/v1/flows/[id]/route";
import { problemasParaAtivar } from "@/lib/flows/validacao";
import { eventoAcionaGatilho, resumoDoGatilho } from "@/lib/flows/triggers";
import { createFlowSchema } from "@/lib/schemas/flows";

const ORG = "org-da-sessao";
const GATILHO = "aaaaaaaa-0000-4000-8000-000000000001";
const FIM = "aaaaaaaa-0000-4000-8000-000000000002";
const ARESTA = "aaaaaaaa-0000-4000-8000-000000000003";

const req = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://crm.test${url}`, { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.banco = criarBanco({ flows: [], flow_nodes: [], flow_edges: [] }, { fn_flow_replace_graph: () => null });
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u-1", idioma: "pt-BR" } });
});

async function criarRascunho(): Promise<string> {
  const res = await criarFluxo(req("/api/v1/flows", "POST", { name: "Sem título" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe("criar o fluxo sem gatilho", () => {
  it("o schema aceita só o nome — e sem nome nasce 'Sem título'", () => {
    const soNome = createFlowSchema.parse({ name: "Boas-vindas" });
    expect(soNome.trigger_type).toBeUndefined();
    expect(createFlowSchema.parse({}).name).toBe("Sem título");
  });

  it("POST { name } cria o rascunho com trigger_type NULO e o nó 'Quando…' sem gatilho", async () => {
    const id = await criarRascunho();
    const fluxo = h.banco.tabelas.flows!.find((f) => f.id === id)!;
    expect(fluxo.trigger_type).toBeNull();
    expect(fluxo.organization_id).toBe(ORG);

    const nos = h.banco.tabelas.flow_nodes!.filter((n) => n.flow_id === id);
    expect(nos).toHaveLength(1);
    expect(nos[0]).toMatchObject({ type: "TRIGGER", label: "Quando…", config: { config: {} } });
    expect((nos[0]!.config as Record<string, unknown>).trigger_type).toBeUndefined();
  });

  it("quem manda o gatilho na criação (API, integração) continua recebendo o fluxo com ele", async () => {
    const res = await criarFluxo(
      req("/api/v1/flows", "POST", { name: "Tag", trigger_type: "contact_tag_added", trigger_config: { tag: "VIP" } }),
    );
    const { data } = (await res.json()) as { data: { id: string; trigger_type: string } };
    expect(data.trigger_type).toBe("contact_tag_added");
  });

  it("gatilho inventado na criação é recusado", async () => {
    const res = await criarFluxo(req("/api/v1/flows", "POST", { name: "x", trigger_type: "inventado" }));
    expect(res.status).toBe(400);
  });
});

describe("salvar o rascunho sem gatilho", () => {
  const grafo = (configDoGatilho: Record<string, unknown>) => ({
    nodes: [
      { id: GATILHO, type: "TRIGGER", label: "Quando…", config: configDoGatilho, position_x: 0, position_y: 0 },
      { id: FIM, type: "END", label: "", config: {}, position_x: 300, position_y: 0 },
    ],
    edges: [{ id: ARESTA, source_node_id: GATILHO, target_node_id: FIM, source_handle: null }],
  });

  it("PUT /graph com o 'Quando…' vazio SALVA — e a linha continua sem gatilho", async () => {
    const id = await criarRascunho();
    const res = await salvarGrafo(req(`/api/v1/flows/${id}/graph`, "PUT", grafo({ config: {} })), params(id));
    expect(res.status).toBe(200);
    expect(h.banco.tabelas.flows!.find((f) => f.id === id)!.trigger_type).toBeNull();
  });

  it("escolher o gatilho no canvas e salvar projeta o gatilho na linha", async () => {
    const id = await criarRascunho();
    const res = await salvarGrafo(
      req(`/api/v1/flows/${id}/graph`, "PUT", grafo({ trigger_type: "contact_tag_added", config: { tag: "VIP" } })),
      params(id),
    );
    expect(res.status).toBe(200);
    expect(h.banco.tabelas.flows!.find((f) => f.id === id)).toMatchObject({
      trigger_type: "contact_tag_added",
      trigger_config: { tag: "VIP" },
    });
  });

  it("gatilho PRESENTE e inventado continua 422 — rascunho não é dado inválido", async () => {
    const id = await criarRascunho();
    const res = await salvarGrafo(req(`/api/v1/flows/${id}/graph`, "PUT", grafo({ trigger_type: "inventado" })), params(id));
    expect(res.status).toBe(422);
  });

  it("sem o nó 'Quando…' continua 422 — o motor precisa do ponto de entrada", async () => {
    const id = await criarRascunho();
    const semGatilho = { nodes: [grafo({}).nodes[1]], edges: [] };
    const res = await salvarGrafo(req(`/api/v1/flows/${id}/graph`, "PUT", semGatilho), params(id));
    expect(res.status).toBe(422);
  });
});

describe("ativar continua exigindo o gatilho", () => {
  it("PATCH status=active num rascunho sem gatilho: 422 com a frase que diz onde escolher", async () => {
    const id = await criarRascunho();
    h.banco.tabelas.flow_nodes!.push({
      id: FIM, organization_id: ORG, flow_id: id, type: "END", label: "", config: {},
    });
    const res = await atualizarFluxo(req(`/api/v1/flows/${id}`, "PATCH", { status: "active" }), params(id));
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("Quando…");
    // A recusa vem ANTES da escrita: o status não virou `active`.
    expect(h.banco.tabelas.flows!.find((f) => f.id === id)!.status).not.toBe("active");
  });

  it("controle: com o gatilho escolhido e salvo, a mesma ativação passa", async () => {
    const id = await criarRascunho();
    const fluxo = h.banco.tabelas.flows!.find((f) => f.id === id)!;
    Object.assign(fluxo, { status: "draft", trigger_type: "contact_tag_added", trigger_config: { tag: "VIP" } });
    h.banco.tabelas.flow_nodes!.push({ id: FIM, organization_id: ORG, flow_id: id, type: "END", label: "", config: {} });
    const res = await atualizarFluxo(req(`/api/v1/flows/${id}`, "PATCH", { status: "active" }), params(id));
    expect(res.status).toBe(200);
  });

  it("a regra pura diz o mesmo, e a tela descreve o rascunho sem inventar gatilho", () => {
    expect(problemasParaAtivar(null, {}, []).join(" ")).toContain("Quando…");
    expect(resumoDoGatilho(null, null)).toMatch(/^Sem gatilho/);
  });

  it("fluxo sem gatilho não é acionado por evento nenhum", () => {
    // O handler lê `trigger_type` da linha; nulo vira a string "null" ali.
    for (const tipo of [String(null), "", "undefined"]) {
      expect(eventoAcionaGatilho(tipo, {}, { event_type: "contact.created", payload: {} })).toBe(false);
    }
  });
});
