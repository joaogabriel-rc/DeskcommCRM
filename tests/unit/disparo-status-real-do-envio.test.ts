import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Origem from "@/lib/atendimento/origem";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";
import {
  gravarMensagemDoDisparo,
  reconciliarDestinatario,
  rpcsDaReconciliacao,
} from "../helpers/disparo-reconciliacao-em-memoria";

/**
 * O STATUS DO DISPARO É O RESULTADO DO ENVIO (migration 0501).
 *
 * O defeito medido: duas mensagens recusadas pela Meta (`failed`, `meta_error`,
 * sem `external_id`) e o disparo `completed`, `sent_count = 2`,
 * `failed_count = 0`. `sendMessageHandler` devolve a linha `failed` em vez de
 * lançar; o worker e o nó de mensagem ignoravam o retorno.
 *
 * O dublê do envio devolve a LINHA com o status que o canal "deu" a cada
 * contato, e liga a mensagem ao destinatário como o handler real faz.
 */

type Comportamento = "sent" | "failed" | "queued" | "throw";

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  porContato: {} as Record<string, Comportamento>,
  envios: 0,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(
    async (
      _db: unknown,
      ctx: { organization_id: string; broadcastRecipientId?: string; proactiveContext?: { contactId: string } },
    ) => {
      h.envios += 1;
      const comp = h.porContato[ctx.proactiveContext?.contactId ?? ""] ?? "sent";
      if (comp === "throw") throw new Error("fetch failed: ECONNRESET");
      return gravarMensagemDoDisparo(h.banco, {
        organization_id: ctx.organization_id,
        broadcast_recipient_id: ctx.broadcastRecipientId ?? null,
        status: comp,
        ...(comp === "failed"
          ? { error_code: "meta_error", error_message: "(#132000) Number of parameters does not match" }
          : {}),
      });
    },
  ),
}));
vi.mock("@/lib/atendimento/origem", async (original) => ({
  ...(await original<typeof Origem>()),
  assertServiceBoundarySupabase: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: vi.fn(async () => {
    throw new Error("TESTE: disparo não deriva permissão de evento");
  }),
}));

import { runBroadcastWorkerTick } from "@/lib/disparos/worker";
import { runFlowWorkerTick } from "@/lib/flows/engine";

const ORG = "org-a";
const MENSAGEM = {
  window_mode: "outside_24h",
  template_name: "var1_teste",
  template_language: "pt_BR",
  template_values: { var1: "{{contact.name}}" },
};

function permissao(contactId: string) {
  return {
    organization_id: ORG,
    contact_id: contactId,
    conversation_id: `conv-${contactId}`,
    service_revision: 1,
    demanda_id: null,
    demanda_revision: null,
  };
}

interface Montagem {
  contatos?: string[];
  bloqueados?: string[];
  mensagem?: Record<string, unknown>;
  /** Passos do fluxo, sem o TRIGGER. Ausente = modo guiado. */
  fluxo?: Array<{ id: string; type: string; config: Record<string, unknown> }>;
}

function montar(o: Montagem = {}) {
  const contatos = o.contatos ?? ["c1"];
  const passos = o.fluxo
    ? [{ id: "t", type: "TRIGGER", config: { trigger_type: "broadcast", config: {} } }, ...o.fluxo]
    : [];
  h.banco = criarBanco(
    {
      broadcasts: [
        {
          id: "b1", organization_id: ORG, name: "Oferta", status: "scheduled",
          message: o.mensagem ?? MENSAGEM, sent_count: 0, failed_count: 0, skipped_count: 0, started_at: null,
        },
      ],
      broadcast_recipients: contatos.map((c) => ({
        id: `r-${c}`, organization_id: ORG, broadcast_id: "b1", contact_id: c, status: "pending",
        error: null, service_boundary: permissao(c),
      })),
      flows: o.fluxo ? [{ id: "f1", organization_id: ORG, broadcast_id: "b1", trigger_type: "broadcast", status: "active" }] : [],
      flow_nodes: passos.map((p) => ({ ...p, organization_id: ORG, flow_id: "f1", label: "" })),
      flow_edges: passos.slice(1).map((p, i) => ({
        id: `e${i}`, organization_id: ORG, flow_id: "f1", source_node_id: passos[i]!.id, target_node_id: p.id, source_handle: null,
      })),
      flow_executions: [],
      flow_execution_events: [],
      messages: [],
      contacts: contatos.map((c) => ({
        id: c, organization_id: ORG, name: `Nome ${c}`, phone_number: "+5511",
        is_blocked: (o.bloqueados ?? []).includes(c), is_anonymized: false, is_merged_into: null,
      })),
      conversations: contatos.map((c) => ({ id: `conv-${c}`, organization_id: ORG, contact_id: c, channel_session_id: "s1" })),
    },
    {
      fn_claim_due_broadcasts: () =>
        h.banco.tabelas.broadcasts!.filter((b) => ["scheduled", "running"].includes(String(b.status))),
      fn_claim_due_broadcast_recipients: (a) =>
        h.banco.tabelas.broadcast_recipients!.filter((r) => r.broadcast_id === a.p_broadcast && r.status === "pending"),
      fn_claim_due_flow_executions: () =>
        h.banco.tabelas.flow_executions!.filter((e) => e.status === "waiting" && e.waiting_for === "delay"),
      ...rpcsDaReconciliacao(() => h.banco),
    },
    { flow_executions: { attempts: 0, last_error: null, conversation_id: null, next_execution_at: null } },
  );
}

const disparo = () => h.banco.tabelas.broadcasts![0]!;
const destinatario = (c: string) => h.banco.tabelas.broadcast_recipients!.find((r) => r.contact_id === c)!;

beforeEach(() => {
  vi.clearAllMocks();
  h.porContato = {};
  h.envios = 0;
});

describe("modo guiado: o destinatário carrega o desfecho do canal", () => {
  it("a Meta ACEITA: sent, contado como enviado, disparo concluído", async () => {
    montar();
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1")).toMatchObject({ status: "sent", error: null });
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 1, failed_count: 0 });
  });

  it("a Meta RECUSA (132000): failed com o motivo do canal, nunca sent", async () => {
    montar();
    h.porContato.c1 = "failed";
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1").status).toBe("failed");
    expect(String(destinatario("c1").error)).toMatch(/meta_error/);
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 0, failed_count: 1 });
  });

  it("BLOQUEIO LOCAL (contato bloqueado): pulado, sem pedido de envio", async () => {
    montar({ bloqueados: ["c1"] });
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toBe(0);
    expect(destinatario("c1")).toMatchObject({ status: "skipped", error: "contato_bloqueado_ou_anonimizado" });
    expect(disparo()).toMatchObject({ sent_count: 0, failed_count: 0, skipped_count: 1 });
  });

  it("ERRO DE TEMPLATE (modelo incompleto): failed antes de falar com o canal", async () => {
    montar({ mensagem: { window_mode: "outside_24h", template_values: {} } });
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toBe(0);
    expect(destinatario("c1")).toMatchObject({ status: "failed", error: "template_incompleto" });
    expect(disparo()).toMatchObject({ sent_count: 0, failed_count: 1 });
  });

  it("FALHA DE REDE/API (o envio lança): failed com o motivo", async () => {
    montar();
    h.porContato.c1 = "throw";
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1").status).toBe("failed");
    expect(String(destinatario("c1").error)).toMatch(/ECONNRESET/);
    expect(disparo()).toMatchObject({ sent_count: 0, failed_count: 1 });
  });

  it("SUCESSO PARCIAL: cada destinatário com o seu desfecho, contadores separados", async () => {
    montar({ contatos: ["c1", "c2", "c3"] });
    h.porContato.c2 = "failed";
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1").status).toBe("sent");
    expect(destinatario("c2").status).toBe("failed");
    expect(destinatario("c3").status).toBe("sent");
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 2, failed_count: 1 });
  });

  it("TODOS FALHARAM: sent_count 0 — o caso medido em produção", async () => {
    montar({ contatos: ["c1", "c2"] });
    h.porContato.c1 = "failed";
    h.porContato.c2 = "failed";
    await runBroadcastWorkerTick(h.banco.client);
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 0, failed_count: 2 });
  });

  it("TODOS COM SUCESSO", async () => {
    montar({ contatos: ["c1", "c2"] });
    await runBroadcastWorkerTick(h.banco.client);
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 2, failed_count: 0 });
  });

  it("EM FILA (canal fora do ar): in_flow e o disparo NÃO conclui; a recusa que chega depois vira failed", async () => {
    montar();
    h.porContato.c1 = "queued";
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1").status).toBe("in_flow");
    expect(disparo()).toMatchObject({ status: "running", sent_count: 0, failed_count: 0, in_flow_count: 1 });

    // O webhook de status marca a mensagem `failed` minutos depois; o gatilho
    // da 0501 reconcilia o destinatário.
    const m = h.banco.tabelas.messages!.find((x) => x.broadcast_recipient_id === "r-c1")!;
    m.status = "failed";
    m.error_code = "meta_error";
    reconciliarDestinatario(h.banco, "r-c1");
    expect(destinatario("c1").status).toBe("failed");
    expect(disparo()).toMatchObject({ status: "completed", failed_count: 1, in_flow_count: 0 });
  });
});

describe("modo fluxo: entrar no fluxo NÃO é enviar", () => {
  const mensagem = { id: "m1", type: "MESSAGE", config: MENSAGEM };

  it("a Meta recusa a mensagem do fluxo: execução failed, destinatário failed, sent_count 0", async () => {
    montar({ contatos: ["c1", "c2"], fluxo: [mensagem] });
    h.porContato.c1 = "failed";
    h.porContato.c2 = "failed";
    await runBroadcastWorkerTick(h.banco.client);
    for (const e of h.banco.tabelas.flow_executions!) {
      expect(e).toMatchObject({ status: "failed", last_error: expect.stringMatching(/envio_recusado:meta_error/) });
    }
    expect(destinatario("c1").status).toBe("failed");
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 0, failed_count: 2 });
  });

  it("sucesso parcial no fluxo", async () => {
    montar({ contatos: ["c1", "c2"], fluxo: [mensagem] });
    h.porContato.c2 = "failed";
    await runBroadcastWorkerTick(h.banco.client);
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 1, failed_count: 1 });
  });

  it("espera ANTES do primeiro envio: in_flow e o disparo segue running até a mensagem sair", async () => {
    montar({ fluxo: [{ id: "d", type: "DELAY", config: { duration_ms: 60_000 } }, mensagem] });
    await runBroadcastWorkerTick(h.banco.client);
    expect(h.envios).toBe(0);
    expect(destinatario("c1").status).toBe("in_flow");
    expect(disparo()).toMatchObject({ status: "running", sent_count: 0, in_flow_count: 1 });

    await runFlowWorkerTick(h.banco.client);
    expect(h.envios).toBe(1);
    expect(destinatario("c1").status).toBe("sent");
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 1, in_flow_count: 0 });
  });

  it("fluxo que termina sem mandar nada: pulado com o motivo, nunca sent", async () => {
    montar({ fluxo: [{ id: "fim", type: "END", config: {} }] });
    await runBroadcastWorkerTick(h.banco.client);
    expect(destinatario("c1")).toMatchObject({ status: "skipped", error: "fluxo_concluido_sem_envio" });
    expect(disparo()).toMatchObject({ status: "completed", sent_count: 0, skipped_count: 1 });
  });
});
