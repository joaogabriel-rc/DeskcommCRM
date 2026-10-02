import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * 0507 · AS ROTAS RESPEITAM O FLUXO PROTEGIDO, E O DISPARO SE DUPLICA.
 *
 * A regra mora no banco (o gatilho recusa qualquer escrita — provado em
 * `tests/invariants/fluxo-de-disparo-protegido.test.ts`). Aqui se prova o lado
 * das ROTAS: que perguntam antes de gravar, respondem 409 com o estado (e não
 * 500), traduzem a recusa do banco que chega pela corrida, e que a duplicação
 * copia os arquivos de imagem para a pasta do fluxo novo — ou desfaz tudo.
 *
 * Sabotagens medidas:
 *   - tirar o desvio `if (flow.broadcast_id)` da rota do grafo → os casos de
 *     "histórico" e "em uso" ficam vermelhos (a rota volta a olhar `status`);
 *   - voltar o DELETE do disparo para `sent_count > 0` → o caso ⭐ (envios
 *     falhos, sent_count 0) fica vermelho;
 *   - tirar o `copy` da duplicação → o caso das imagens fica vermelho.
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  audit: vi.fn(),
  copy: vi.fn(),
  replaceGraph: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-a" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ copy: h.copy }) } }),
}));

import { DELETE as apagarDisparo } from "@/app/api/v1/broadcasts/[id]/route";
import { POST as duplicar } from "@/app/api/v1/broadcasts/[id]/duplicar/route";
import { GET as lerFluxo } from "@/app/api/v1/flows/[id]/route";
import { PUT as salvarGrafo } from "@/app/api/v1/flows/[id]/graph/route";
import { POST as subirImagem } from "@/app/api/v1/flows/[id]/media/route";

const ORG = "org-a";
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://crm.test${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
/** O client em memória com a RPC trocada: devolver um ERRO do banco é o que o caso precisa. */
type Rpc = (nome: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
function trocarRpc(nome: string, erro: { code: string; message: string }) {
  const cliente = h.banco.client as unknown as { rpc: Rpc };
  const original = cliente.rpc.bind(cliente);
  cliente.rpc = async (n, args) => (n === nome ? { data: null, error: erro } : original(n, args));
}
const corpo = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };

/** Disparo + fluxo de disparo, no status pedido; `execucoes` fabrica o uso. */
function cenario(status: string, opts: { execucoes?: number; recipientes?: string[] } = {}) {
  h.banco.tabelas.broadcasts!.push({ id: "d1", organization_id: ORG, name: "Disparo", status, sent_count: 0 });
  h.banco.tabelas.flows!.push({ id: "f1", organization_id: ORG, name: "Disparo: x", status: "active", broadcast_id: "d1", trigger_type: "broadcast", trigger_config: {}, version: 3 });
  h.banco.tabelas.flow_nodes!.push({ id: "n1", organization_id: ORG, flow_id: "f1", type: "TRIGGER", config: {} });
  for (let i = 0; i < (opts.execucoes ?? 0); i++) {
    h.banco.tabelas.flow_executions!.push({ id: `e${i}`, organization_id: ORG, flow_id: "f1", status: "completed" });
  }
  for (const [i, st] of (opts.recipientes ?? []).entries()) {
    h.banco.tabelas.broadcast_recipients!.push({ id: `r${i}`, organization_id: ORG, broadcast_id: "d1", status: st });
  }
}

const grafo = { nodes: [{ id: "00000000-0000-4000-8000-000000000001", type: "TRIGGER", config: { trigger_type: "broadcast", config: {} }, position_x: 0, position_y: 0 }], edges: [] };

beforeEach(() => {
  vi.clearAllMocks();
  h.copy.mockResolvedValue({ data: {}, error: null });
  h.replaceGraph.mockReturnValue(null);
  h.banco = criarBanco(
    { broadcasts: [], flows: [], flow_nodes: [], flow_edges: [], flow_executions: [], broadcast_recipients: [] },
    {
      fn_flow_estado_de_edicao: (args) => {
        const f = h.banco.tabelas.flows!.find((x) => x.id === args.p_flow);
        if (!f) return null;
        if (!f.broadcast_id) return { escopo: "automacao", estado: null, vivas: 0, usado: false, disparo_status: null };
        const st = String(h.banco.tabelas.broadcasts!.find((b) => b.id === f.broadcast_id)?.status);
        const usado = h.banco.tabelas.flow_executions!.some((e) => e.flow_id === f.id);
        const estado = ["completed", "cancelled", "failed"].includes(st)
          ? "historico"
          : ["scheduled", "running"].includes(st)
            ? "em_uso"
            : usado
              ? "historico"
              : "editavel";
        return { escopo: "disparo", estado, vivas: 0, usado, disparo_status: st };
      },
      fn_flow_replace_graph: (args) => h.replaceGraph(args),
    },
  );
});

describe("salvar o grafo (PUT /flows/[id]/graph)", () => {
  it.each([
    ["completed", {}, "historico"],
    ["paused", { execucoes: 1 }, "historico"],
    ["running", {}, "em_uso"],
    ["scheduled", {}, "em_uso"],
  ] as const)("disparo %s %o: 409 flow_protegido (%s), sem tocar no grafo", async (status, opts, estado) => {
    cenario(status, opts);
    const r = await salvarGrafo(req("/api/v1/flows/f1/graph", "PUT", grafo), params("f1"));
    expect(r.status).toBe(409);
    const b = await corpo(r);
    expect(b.error?.code).toBe("flow_protegido");
    expect(b.error?.details).toEqual({ estado });
    expect(h.replaceGraph).not.toHaveBeenCalled();
  });

  it("disparo pausado ANTES de alguém entrar: salva, mesmo com o fluxo `active`", async () => {
    cenario("paused");
    const r = await salvarGrafo(req("/api/v1/flows/f1/graph", "PUT", grafo), params("f1"));
    expect(r.status).toBe(200);
    expect(h.replaceGraph).toHaveBeenCalledTimes(1);
  });

  it("a recusa do banco que chega pela corrida (PT409) vira 409, não 500", async () => {
    cenario("draft");
    // A pergunta disse "editável"; o gatilho do banco recusa na escrita (o
    // disparo foi agendado no meio) — a RPC devolve o erro PT409.
    trocarRpc("fn_flow_replace_graph", { code: "PT409", message: "flow_protegido:em_uso" });
    const r = await salvarGrafo(req("/api/v1/flows/f1/graph", "PUT", grafo), params("f1"));
    expect(r.status).toBe(409);
    expect((await corpo(r)).error?.details).toEqual({ estado: "em_uso" });
  });

  it("fluxo de Automações ativo: a trava de sempre (pausar para editar)", async () => {
    h.banco.tabelas.flows!.push({ id: "fa", organization_id: ORG, name: "Auto", status: "active", broadcast_id: null, trigger_type: "contact_created", trigger_config: {}, version: 1 });
    const r = await salvarGrafo(
      req("/api/v1/flows/fa/graph", "PUT", { nodes: [{ id: "00000000-0000-4000-8000-000000000002", type: "TRIGGER", config: { trigger_type: "contact_created", config: {} }, position_x: 0, position_y: 0 }], edges: [] }),
      params("fa"),
    );
    expect(r.status).toBe(409);
    expect((await corpo(r)).error?.code).toBe("flow_must_pause_to_edit_graph");
  });
});

describe("ler o fluxo e subir imagem", () => {
  it("GET /flows/[id] devolve o estado de uso do fluxo de disparo", async () => {
    cenario("completed", { execucoes: 2 });
    const b = await corpo(await lerFluxo(req("/api/v1/flows/f1", "GET"), params("f1")));
    expect(b.data?.uso).toMatchObject({ escopo: "disparo", estado: "historico", usado: true });
  });

  it("POST /flows/[id]/media em fluxo protegido: 409 antes de ler o arquivo", async () => {
    cenario("completed");
    const r = await subirImagem(req("/api/v1/flows/f1/media", "POST"), params("f1"));
    expect(r.status).toBe(409);
    expect((await corpo(r)).error?.code).toBe("flow_protegido");
  });
});

describe("apagar o disparo (DELETE /broadcasts/[id])", () => {
  it("⭐ concluído com sent_count = 0 mas destinatários falhos: 409, nada apagado", async () => {
    cenario("completed", { recipientes: ["failed", "failed"] });
    const r = await apagarDisparo(req("/api/v1/broadcasts/d1", "DELETE"), params("d1"));
    expect(r.status).toBe(409);
    expect(h.banco.tabelas.broadcasts).toHaveLength(1);
  });

  it("com execução e nenhum destinatário processado: 409", async () => {
    cenario("paused", { execucoes: 1, recipientes: ["pending"] });
    expect((await apagarDisparo(req("/api/v1/broadcasts/d1", "DELETE"), params("d1"))).status).toBe(409);
  });

  it("rascunho sem nada: apaga", async () => {
    cenario("draft");
    const r = await apagarDisparo(req("/api/v1/broadcasts/d1", "DELETE"), params("d1"));
    expect(r.status).toBe(200);
    expect(h.banco.tabelas.broadcasts).toHaveLength(0);
  });
});

describe("duplicar (POST /broadcasts/[id]/duplicar)", () => {
  function registrarDuplicacao(caminhos: string[]) {
    h.banco.rpcs.fn_broadcast_duplicar = () => {
      h.banco.tabelas.broadcasts!.push({ id: "d2", organization_id: ORG, name: "Disparo (cópia)", status: "draft" });
      h.banco.tabelas.flow_nodes!.push({
        id: "n9",
        organization_id: ORG,
        flow_id: "f2",
        type: "MESSAGE",
        config: { blocks: caminhos.map((c, i) => ({ id: `b${i}`, tipo: "imagem", media_storage_path: c })) },
      });
      return { broadcast_id: "d2", flow_id: "f2", flow_id_origem: "f1" };
    };
  }

  it("copia cada imagem da pasta do fluxo de origem para a do novo, e audita", async () => {
    cenario("completed", { execucoes: 1 });
    registrarDuplicacao([`${ORG}/flows/f2/a.jpg`, `${ORG}/flows/f2/b.png`]);
    const r = await duplicar(req("/api/v1/broadcasts/d1/duplicar", "POST", {}), params("d1"));
    expect(r.status).toBe(201);
    expect((await corpo(r)).data).toEqual({ broadcast_id: "d2", flow_id: "f2", flow_id_origem: "f1" });
    expect(h.copy.mock.calls).toEqual([
      [`${ORG}/flows/f1/a.jpg`, `${ORG}/flows/f2/a.jpg`],
      [`${ORG}/flows/f1/b.png`, `${ORG}/flows/f2/b.png`],
    ]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "broadcast.duplicated", resourceId: "d2", metadata: expect.objectContaining({ origem: "d1", imagens_copiadas: 2 }) }),
    );
  });

  it("se uma cópia de imagem falha, o disparo novo é apagado e a resposta é erro", async () => {
    cenario("completed");
    registrarDuplicacao([`${ORG}/flows/f2/a.jpg`]);
    h.copy.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    const r = await duplicar(req("/api/v1/broadcasts/d1/duplicar", "POST", {}), params("d1"));
    expect(r.status).toBe(500);
    expect(h.banco.tabelas.broadcasts!.map((b) => b.id)).toEqual(["d1"]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  // 0508: o caminho da imagem é entrada (config do nó) — só passa no formato
  // exato da pasta do fluxo; fora dele nada é lido nem copiado e a cópia é desfeita.
  it.each([
    ["../ para fora da pasta", `${ORG}/flows/f2/../../org-b/conv/a.jpg`],
    ["pasta de outro fluxo", `${ORG}/flows/f7/a.jpg`],
    ["outra organização", `org-b/flows/f2/a.jpg`],
    ["segmento extra", `${ORG}/flows/f2/sub/a.jpg`],
    ["traversal codificado", `${ORG}/flows/f2/%2e%2e%2fa.jpg`],
  ])("imagem com caminho fora do contrato (%s): 422, nenhuma cópia, disparo novo desfeito", async (_d, caminho) => {
    cenario("completed");
    registrarDuplicacao([`${ORG}/flows/f2/ok.jpg`, caminho]);
    const r = await duplicar(req("/api/v1/broadcasts/d1/duplicar", "POST", {}), params("d1"));
    expect(r.status).toBe(422);
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.banco.tabelas.broadcasts!.map((b) => b.id)).toEqual(["d1"]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("disparo de outra organização (P0002): 404", async () => {
    trocarRpc("fn_broadcast_duplicar", { code: "P0002", message: "broadcast_not_found_in_organization" });
    expect((await duplicar(req("/api/v1/broadcasts/x/duplicar", "POST", {}), params("x"))).status).toBe(404);
  });
});
