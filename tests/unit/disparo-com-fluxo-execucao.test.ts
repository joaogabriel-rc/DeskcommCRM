import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Origem from "@/lib/atendimento/origem";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * DISPARO → EXECUÇÃO DO FLUXO → MENSAGEM, carregando a permissão do disparo.
 *
 * Sob prova (motor e worker de verdade; banco dublê que aplica filtro):
 *
 *   1. AUTORIZADA: o worker inicia a execução com a permissão MATERIALIZADA do
 *      destinatário; o nó de mensagem envia com ESSA permissão, reconferida por
 *      `assertServiceBoundarySupabase` — e nunca deriva uma de evento
 *      (`serviceForAutomation` quebra o teste se for chamado);
 *   2. RETOMADA: depois de uma espera, o relógio que o motor JÁ tem
 *      (`runFlowWorkerTick`) segue a execução, e a mensagem seguinte sai com a
 *      MESMA permissão, relida da execução;
 *   3. NÃO AUTORIZADA: sem permissão, permissão de outro contato ou de outra
 *      organização, permissão vencida, número diferente do da conversa — não
 *      envia nada;
 *   4. CROSS-TENANT: um fluxo de outra organização nunca é executado pelo
 *      disparo desta.
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  envios: [] as Array<{ boundary: unknown; input: Record<string, unknown> }>,
  reconferidas: [] as unknown[],
  vencida: false,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(async (_db: unknown, ctx: { serviceBoundary: unknown }, input: Record<string, unknown>) => {
    h.envios.push({ boundary: ctx.serviceBoundary, input });
    return { id: "msg-1" };
  }),
}));
vi.mock("@/lib/atendimento/origem", async (original) => ({
  ...(await original<typeof Origem>()),
  assertServiceBoundarySupabase: vi.fn(async (_db: unknown, b: unknown) => {
    h.reconferidas.push(b);
    if (h.vencida) throw new Error("service_stale");
  }),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: vi.fn(async () => {
    throw new Error("TESTE: execução de disparo NÃO pode derivar permissão de evento");
  }),
}));

import { runBroadcastWorkerTick } from "@/lib/disparos/worker";
import { runFlowWorkerTick } from "@/lib/flows/engine";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";

const ORG = "org-a";
const OUTRA = "org-b";
const SESSAO = "sess-1";
const MENSAGEM = {
  window_mode: "outside_24h",
  template_name: "boas",
  template_language: "pt_BR",
  template_values: { "1": "{{contact.name}}" },
  channel_session_id: SESSAO,
};

function permissao(o: Partial<Record<string, unknown>> = {}) {
  return {
    organization_id: ORG,
    contact_id: "c1",
    conversation_id: "conv-1",
    service_revision: 1,
    demanda_id: null,
    demanda_revision: null,
    ...o,
  };
}

function montar(o: { permissao?: unknown; fluxoDaOrg?: string; comEspera?: boolean; canalDaConversa?: string } = {}) {
  const passos = o.comEspera
    ? [
        { id: "t", type: "TRIGGER", config: { trigger_type: "broadcast", config: {} } },
        { id: "m1", type: "MESSAGE", config: MENSAGEM },
        { id: "d", type: "DELAY", config: { duration_ms: 60_000 } },
        { id: "m2", type: "MESSAGE", config: { ...MENSAGEM, template_name: "lembrete" } },
      ]
    : [
        { id: "t", type: "TRIGGER", config: { trigger_type: "broadcast", config: {} } },
        { id: "m1", type: "MESSAGE", config: MENSAGEM },
      ];
  const org = o.fluxoDaOrg ?? ORG;
  h.banco = criarBanco(
    {
      broadcasts: [
        { id: "b1", organization_id: ORG, name: "Oferta", status: "scheduled", message: {}, sent_count: 0, failed_count: 0, started_at: null },
      ],
      broadcast_recipients: [
        {
          id: "r1", organization_id: ORG, broadcast_id: "b1", contact_id: "c1", status: "pending",
          service_boundary: o.permissao === undefined ? permissao() : o.permissao,
        },
      ],
      flows: [{ id: "f1", organization_id: org, broadcast_id: "b1", trigger_type: "broadcast", status: "active" }],
      flow_nodes: passos.map((p) => ({ ...p, organization_id: org, flow_id: "f1", label: "" })),
      flow_edges: passos.slice(1).map((p, i) => ({
        id: `e${i}`, organization_id: org, flow_id: "f1", source_node_id: passos[i]!.id, target_node_id: p.id, source_handle: null,
      })),
      flow_executions: [],
      flow_execution_events: [],
      contacts: [
        { id: "c1", organization_id: ORG, name: "Ana", phone_number: "+5511", is_blocked: false, is_anonymized: false, is_merged_into: null },
      ],
      conversations: [{ id: "conv-1", organization_id: ORG, contact_id: "c1", channel_session_id: o.canalDaConversa ?? SESSAO }],
    },
    {
      fn_claim_due_broadcasts: () => h.banco.tabelas.broadcasts!.filter((b) => ["scheduled", "running"].includes(String(b.status))),
      fn_claim_due_broadcast_recipients: (a) =>
        h.banco.tabelas.broadcast_recipients!.filter((r) => r.broadcast_id === a.p_broadcast && r.status === "pending"),
      fn_claim_due_flow_executions: () =>
        h.banco.tabelas.flow_executions!.filter((e) => e.status === "waiting" && e.waiting_for === "delay"),
    },
    { flow_executions: { attempts: 0, last_error: null, conversation_id: null, next_execution_at: null } },
  );
}

const destinatario = () => h.banco.tabelas.broadcast_recipients![0]!;
const execucoes = () => h.banco.tabelas.flow_executions!;

beforeEach(() => {
  vi.clearAllMocks();
  h.envios = [];
  h.reconferidas = [];
  h.vencida = false;
});

describe("autorizada: a permissão do disparo chega ao nó de mensagem", () => {
  it("o destinatário entra no fluxo e a mensagem sai com A permissão materializada", async () => {
    montar();
    await runBroadcastWorkerTick(h.banco.client);

    expect(execucoes()).toHaveLength(1);
    expect(execucoes()[0]).toMatchObject({
      organization_id: ORG,
      flow_id: "f1",
      contact_id: "c1",
      broadcast_recipient_id: "r1",
      service_boundary: permissao(),
    });
    expect(h.envios).toHaveLength(1);
    expect(h.envios[0]!.boundary).toEqual(permissao());
    expect(h.envios[0]!.input).toMatchObject({ type: "template", template_name: "boas", template_values: { "1": "Ana" } });
    expect(h.reconferidas.length).toBeGreaterThanOrEqual(1);
    expect(serviceForAutomation).not.toHaveBeenCalled();
    expect(destinatario()).toMatchObject({ status: "sent", error: null });
  });

  it("um segundo tick não inicia uma segunda execução nem manda de novo", async () => {
    montar();
    await runBroadcastWorkerTick(h.banco.client);
    // Um lease que venceu no meio do lote: o destinatário volta à fila e o
    // disparo volta a ser reclamável.
    destinatario().status = "pending";
    h.banco.tabelas.broadcasts![0]!.status = "running";
    // O índice único por destinatário é do BANCO; aqui o dublê simula o 23505.
    const original = h.banco.client as unknown as { from: (t: string) => unknown };
    const from = original.from.bind(original);
    (original as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t) as Record<string, unknown>;
      if (t !== "flow_executions") return q;
      const insert = q.insert as (l: unknown) => Record<string, unknown>;
      q.insert = (l: unknown) => {
        const r = insert(l);
        r.maybeSingle = async () => ({ data: null, error: { code: "23505", message: "duplicate" } });
        return r;
      };
      return q;
    };
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toHaveLength(1);
    expect(destinatario()).toMatchObject({ status: "sent" });
  });
});

describe("retomada: a mensagem depois da espera usa a MESMA permissão", () => {
  it("o relógio do motor (flow-worker) retoma e o segundo envio leva a permissão relida da execução", async () => {
    montar({ comEspera: true });
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toHaveLength(1);
    expect(execucoes()[0]).toMatchObject({ status: "waiting", waiting_for: "delay" });

    await runFlowWorkerTick(h.banco.client);

    expect(h.envios).toHaveLength(2);
    expect(h.envios[1]!.input).toMatchObject({ template_name: "lembrete" });
    expect(h.envios[1]!.boundary).toEqual(permissao());
    expect(serviceForAutomation).not.toHaveBeenCalled();
    expect(execucoes()[0]).toMatchObject({ status: "completed" });
  });
});

describe("não autorizada: nada sai", () => {
  it("sem permissão materializada: o destinatário é pulado e ninguém entra no fluxo", async () => {
    montar({ permissao: null });
    await runBroadcastWorkerTick(h.banco.client);
    expect(execucoes()).toHaveLength(0);
    expect(h.envios).toHaveLength(0);
    expect(destinatario()).toMatchObject({ status: "skipped", error: "sem_fronteira_de_servico" });
  });

  it("permissão de OUTRO contato: pulado", async () => {
    montar({ permissao: permissao({ contact_id: "c-outro" }) });
    await runBroadcastWorkerTick(h.banco.client);
    expect(execucoes()).toHaveLength(0);
    expect(h.envios).toHaveLength(0);
    expect(destinatario()).toMatchObject({ status: "skipped", error: "service_scope_mismatch" });
  });

  it("permissão de OUTRA organização: pulado", async () => {
    montar({ permissao: permissao({ organization_id: OUTRA }) });
    await runBroadcastWorkerTick(h.banco.client);
    expect(execucoes()).toHaveLength(0);
    expect(h.envios).toHaveLength(0);
    expect(destinatario()).toMatchObject({ status: "skipped", error: "service_scope_mismatch" });
  });

  it("permissão VENCIDA (o atendimento mudou desde o agendamento): falha, sem envio", async () => {
    montar();
    h.vencida = true;
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toHaveLength(0);
    expect(destinatario()).toMatchObject({ status: "failed" });
    expect(String(destinatario().error)).toMatch(/service_stale/);
  });

  it("o passo fixa um número e a conversa da permissão é de OUTRO: a execução falha, sem envio", async () => {
    montar({ canalDaConversa: "sess-outro" });
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toHaveLength(0);
    expect(execucoes()[0]).toMatchObject({ status: "failed", last_error: expect.stringMatching(/service_channel_mismatch/) });
    expect(destinatario()).toMatchObject({ status: "failed" });
  });
});

describe("cross-tenant", () => {
  it("o fluxo é de OUTRA organização: o disparo desta nunca o executa", async () => {
    montar({ fluxoDaOrg: OUTRA });
    await runBroadcastWorkerTick(h.banco.client);
    expect(execucoes()).toHaveLength(0);
    // Sem fluxo da organização, o disparo cai no modo guiado — com mensagem
    // vazia, recusada ANTES do envio.
    expect(h.envios).toHaveLength(0);
    // E foi a PRIMEIRA camada que barrou (a busca do fluxo recortada pela
    // organização do disparo), não a segunda (o grafo recortado pela da
    // execução, que daria `no_entry_node`). Sem esta linha, tirar o filtro da
    // busca passava despercebido — medido na sabotagem.
    expect(destinatario()).toMatchObject({ status: "failed", error: expect.stringMatching(/template_incompleto/) });
  });
});
