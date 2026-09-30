import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Origem from "@/lib/atendimento/origem";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";
import { gravarMensagemDoDisparo, rpcsDaReconciliacao } from "../helpers/disparo-reconciliacao-em-memoria";

/**
 * O NÓ "ENVIAR MENSAGEM" EM BLOCOS (migration 0502) — motor, worker e handler
 * de resposta de verdade, sobre o banco dublê que aplica filtro.
 *
 * Sob prova:
 *   - vários blocos num nó saem EM ORDEM (texto, imagem, texto);
 *   - o atraso DENTRO do nó é durável: a execução para com o cursor gravado, e
 *     o relógio (`runFlowWorkerTick`) reentra o MESMO nó do bloco seguinte;
 *   - um worker que "reinicia" depois de um bloco enviado não o reenvia;
 *   - botão com URL abre o site (vira linha no texto) e NÃO é saída;
 *   - botão sem URL é saída; BOTÃO ≠ PRÓXIMO PASSO: o fluxo segue pelo Próximo
 *     passo sem esperar o clique, e o clique tardio DESVIA a mesma execução;
 *   - sem Próximo passo ligado, o nó ainda espera o clique (compatibilidade);
 *   - a mesma estrutura roda no fluxo de um DISPARO.
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  envios: [] as Array<Record<string, unknown>>,
  copias: [] as Array<{ de: string; para: string }>,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.client }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(
    async (_db: unknown, ctx: { organization_id: string; broadcastRecipientId?: string }, input: Record<string, unknown>) => {
      h.envios.push(input);
      return gravarMensagemDoDisparo(h.banco, {
        organization_id: ctx.organization_id,
        broadcast_recipient_id: ctx.broadcastRecipientId ?? null,
        status: "sent",
      });
    },
  ),
}));
vi.mock("@/lib/atendimento/origem", async (original) => ({
  ...(await original<typeof Origem>()),
  assertServiceBoundarySupabase: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: vi.fn(async () => ({
    organization_id: "org-a",
    contact_id: "c1",
    conversation_id: "conv-1",
    service_revision: 1,
    demanda_id: null,
    demanda_revision: null,
  })),
}));

import { runBroadcastWorkerTick } from "@/lib/disparos/worker";
import { problemasDosBlocos, saidasDeBotao } from "@/lib/flows/blocos";
import { runFlowWorkerTick, startFlowExecution } from "@/lib/flows/engine";
import { nextNode } from "@/lib/flows/graph";
import { flowReplyHandler } from "@/lib/flows/reply.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import type { BlocoDaMensagem, BotaoDoBloco } from "@/lib/flows/blocos";

const ORG = "org-a";

type No = { id: string; type: string; config: Record<string, unknown> };
type Aresta = { de: string; para: string; handle?: string | null };

function montar(nos: No[], arestas: Aresta[], o: { disparo?: boolean } = {}) {
  h.banco = criarBanco(
    {
      flows: [
        {
          id: "f1",
          organization_id: ORG,
          status: "active",
          trigger_type: o.disparo ? "broadcast" : "contact_tag_added",
          ...(o.disparo ? { broadcast_id: "b1" } : {}),
        },
      ],
      flow_nodes: [
        { id: "t", type: "TRIGGER", config: { trigger_type: o.disparo ? "broadcast" : "contact_tag_added", config: {} } },
        ...nos,
      ].map((n) => ({ ...n, organization_id: ORG, flow_id: "f1", label: "" })),
      flow_edges: arestas.map((a, i) => ({
        id: `e${i}`,
        organization_id: ORG,
        flow_id: "f1",
        source_node_id: a.de,
        target_node_id: a.para,
        source_handle: a.handle ?? null,
      })),
      flow_executions: [],
      flow_execution_events: [],
      messages: [],
      contacts: [
        { id: "c1", organization_id: ORG, name: "João da Silva", phone_number: "+5511", is_blocked: false, is_anonymized: false, is_merged_into: null },
      ],
      conversations: [{ id: "conv-1", organization_id: ORG, contact_id: "c1", channel_session_id: "s1" }],
      broadcasts: o.disparo
        ? [{ id: "b1", organization_id: ORG, name: "D", status: "scheduled", message: {}, sent_count: 0, failed_count: 0, started_at: null }]
        : [],
      broadcast_recipients: o.disparo
        ? [
            {
              id: "r1",
              organization_id: ORG,
              broadcast_id: "b1",
              contact_id: "c1",
              status: "pending",
              error: null,
              service_boundary: {
                organization_id: ORG,
                contact_id: "c1",
                conversation_id: "conv-1",
                service_revision: 1,
                demanda_id: null,
                demanda_revision: null,
              },
            },
          ]
        : [],
    },
    {
      fn_claim_due_flow_executions: () =>
        h.banco.tabelas.flow_executions!.filter(
          (e) => e.status === "waiting" && e.waiting_for === "delay" && String(e.next_execution_at) <= new Date(Date.now() + 86_400_000 * 2).toISOString(),
        ),
      fn_claim_due_broadcasts: () =>
        h.banco.tabelas.broadcasts!.filter((b) => ["scheduled", "running"].includes(String(b.status))),
      fn_claim_due_broadcast_recipients: (a) =>
        h.banco.tabelas.broadcast_recipients!.filter((r) => r.broadcast_id === a.p_broadcast && r.status === "pending"),
      ...rpcsDaReconciliacao(() => h.banco),
    },
    {
      flow_executions: {
        attempts: 0,
        last_error: null,
        conversation_id: null,
        next_execution_at: null,
        node_cursor: null,
        listening_node_id: null,
        listening_until: null,
      },
    },
  );
  (h.banco.client as unknown as { storage: unknown }).storage = {
    from: () => ({
      copy: async (de: string, para: string) => {
        h.copias.push({ de, para });
        return { error: null };
      },
    }),
  };
}

const mensagem = (id: string, blocks: BlocoDaMensagem[]): No => ({ id, type: "MESSAGE", config: { blocks } });
const texto = (id: string, t: string, botoes?: BotaoDoBloco[]): BlocoDaMensagem => ({
  id,
  tipo: "texto",
  texto: t,
  ...(botoes ? { botoes } : {}),
});
const execucao = () => h.banco.tabelas.flow_executions![0]!;
const corpos = () => h.envios.map((e) => (e.type === "image" ? `[imagem ${String(e.media_storage_path)}]` : String(e.body)));
const iniciar = () => startFlowExecution(h.banco.client, { organizationId: ORG, flowId: "f1", contactId: "c1" });
const responder = (texto: string) =>
  flowReplyHandler.handle({
    id: "ev-1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m-in",
    payload: { contact_id: "c1", body_preview: texto },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as unknown as EventRow);

beforeEach(() => {
  vi.clearAllMocks();
  h.envios = [];
  h.copias = [];
});

describe("vários blocos num nó só", () => {
  it("texto + imagem + texto saem EM ORDEM, e a imagem é copiada para a pasta da conversa", async () => {
    montar(
      [
        mensagem("m1", [
          texto("a", "Olá, {{contact.first_name}}!"),
          { id: "img", tipo: "imagem", media_storage_path: `${ORG}/flows/f1/foto.png`, media_mime: "image/png", legenda: "Seu pedido" },
          texto("b", "Confira os detalhes abaixo."),
        ]),
        { id: "fim", type: "END", config: {} },
      ],
      [
        { de: "t", para: "m1" },
        { de: "m1", para: "fim" },
      ],
    );
    await iniciar();
    expect(h.envios).toHaveLength(3);
    expect(h.envios[0]).toMatchObject({ type: "text", body: "Olá, João!" });
    expect(h.envios[1]).toMatchObject({ type: "image", body: "Seu pedido", media_mime: "image/png" });
    expect(String(h.envios[1]!.media_storage_path)).toMatch(new RegExp(`^${ORG}/conv-1/fluxo-[0-9a-f]{16}\\.png$`));
    expect(h.copias).toEqual([{ de: `${ORG}/flows/f1/foto.png`, para: h.envios[1]!.media_storage_path }]);
    expect(h.envios[2]).toMatchObject({ type: "text", body: "Confira os detalhes abaixo." });
    expect(execucao()).toMatchObject({ status: "completed" });
  });

  it("imagem de OUTRA organização no config não sai (nem é copiada)", async () => {
    montar(
      [mensagem("m1", [{ id: "img", tipo: "imagem", media_storage_path: "org-b/flows/f9/x.png" }])],
      [{ de: "t", para: "m1" }],
    );
    await iniciar();
    expect(h.envios).toHaveLength(0);
    expect(h.copias).toHaveLength(0);
    expect(execucao()).toMatchObject({ status: "failed", last_error: "imagem_fora_da_organizacao" });
  });
});

describe("atraso DENTRO do nó — durável, pelo relógio do motor", () => {
  const nos = () => [
    mensagem("m1", [
      texto("a", "Texto 1"),
      { id: "d1", tipo: "atraso", segundos: 3 },
      texto("b", "Texto 2"),
      { id: "d2", tipo: "atraso", segundos: 5 },
      texto("c", "Texto 3"),
    ]),
    { id: "fim", type: "END", config: {} },
  ];

  it("texto → espera 3 s → texto → espera 5 s → texto, cada espera gravada com o cursor", async () => {
    montar(nos(), [
      { de: "t", para: "m1" },
      { de: "m1", para: "fim" },
    ]);
    const antes = Date.now();
    await iniciar();
    expect(corpos()).toEqual(["Texto 1"]);
    expect(execucao()).toMatchObject({ status: "waiting", waiting_for: "delay", waiting_node_id: "m1", node_cursor: 2 });
    const ate = new Date(String(execucao().next_execution_at)).getTime();
    expect(ate - antes).toBeGreaterThanOrEqual(3000);
    expect(ate - antes).toBeLessThan(10_000);

    await runFlowWorkerTick(h.banco.client);
    expect(corpos()).toEqual(["Texto 1", "Texto 2"]);
    expect(execucao()).toMatchObject({ status: "waiting", waiting_node_id: "m1", node_cursor: 4 });

    await runFlowWorkerTick(h.banco.client);
    expect(corpos()).toEqual(["Texto 1", "Texto 2", "Texto 3"]);
    expect(execucao()).toMatchObject({ status: "completed" });
  });

  it("RETOMADA DEPOIS DE REINÍCIO: o bloco que já saiu não é reenviado", async () => {
    montar(nos(), [
      { de: "t", para: "m1" },
      { de: "m1", para: "fim" },
    ]);
    await iniciar();
    // O processo "morreu" e voltou: tudo que ele sabe está NA LINHA da execução.
    h.envios = [];
    await runFlowWorkerTick(h.banco.client);
    expect(corpos()).toEqual(["Texto 2"]);
    expect(execucao().node_cursor).toBe(4);
  });

  it("o cursor é gravado a CADA bloco enviado (a queda no meio não repete o que saiu)", async () => {
    montar(
      [mensagem("m1", [texto("a", "Um"), texto("b", "Dois"), { id: "d", tipo: "atraso", segundos: 60 }])],
      [{ de: "t", para: "m1" }],
    );
    await iniciar();
    expect(corpos()).toEqual(["Um", "Dois"]);
    expect(execucao().node_cursor).toBe(3);
  });
});

describe("botões: URL abre o site; sem URL é saída", () => {
  it("botão com URL vira linha com o endereço e NÃO é saída — o fluxo segue", async () => {
    montar(
      [
        mensagem("m1", [
          texto("a", "Seu material está pronto.", [{ id: "u", rotulo: "ACESSAR CURSO", acao: "url", url: "https://curso.test/aula" }]),
        ]),
        mensagem("m2", [texto("b", "Mensagem seguinte")]),
      ],
      [
        { de: "t", para: "m1" },
        { de: "m1", para: "m2" },
      ],
    );
    expect(saidasDeBotao(h.banco.tabelas.flow_nodes!.find((n) => n.id === "m1")!.config as never)).toEqual([]);
    await iniciar();
    expect(corpos()).toEqual(["Seu material está pronto.\nACESSAR CURSO: https://curso.test/aula", "Mensagem seguinte"]);
    expect(execucao()).toMatchObject({ status: "completed", listening_node_id: null });
  });

  it("botão sem URL: opção numerada, e a saída é `button:<id>`", async () => {
    montar(
      [mensagem("m1", [texto("a", "Escolha", [{ id: "sim", rotulo: "Sim", acao: "fluxo" }, { id: "nao", rotulo: "Não", acao: "fluxo" }])])],
      [{ de: "t", para: "m1" }],
    );
    await iniciar();
    expect(corpos()).toEqual(["Escolha\n1. Sim\n2. Não"]);
    expect(saidasDeBotao(h.banco.tabelas.flow_nodes!.find((n) => n.id === "m1")!.config as never)).toEqual([
      { handle: "button:sim", rotulo: "Sim" },
      { handle: "button:nao", rotulo: "Não" },
    ]);
  });
});

describe("BOTÃO ≠ PRÓXIMO PASSO", () => {
  const grafo = () =>
    montar(
      [
        mensagem("m1", [
          texto("a", "Conseguiu acessar?", [
            { id: "ok", rotulo: "VERIFICAR GRUPO", acao: "fluxo" },
            { id: "u", rotulo: "ACESSAR CURSO", acao: "url", url: "https://curso.test" },
          ]),
        ]),
        { id: "espera", type: "DELAY", config: { duration_ms: 120_000 } },
        mensagem("m2", [texto("b", "Lembrete: o material está no grupo.")]),
        mensagem("mb", [texto("c", "Obrigado por confirmar!")]),
      ],
      [
        { de: "t", para: "m1" },
        { de: "m1", para: "espera" }, // Próximo passo
        { de: "espera", para: "m2" },
        { de: "m1", para: "mb", handle: "button:ok" },
      ],
    );

  it("sem clique, o fluxo SEGUE pelo Próximo passo e os botões ficam clicáveis", async () => {
    grafo();
    await iniciar();
    expect(corpos()).toEqual(["Conseguiu acessar?\n1. VERIFICAR GRUPO\nACESSAR CURSO: https://curso.test"]);
    expect(execucao()).toMatchObject({ status: "waiting", waiting_for: "delay", waiting_node_id: "espera", listening_node_id: "m1" });
    expect(new Date(String(execucao().listening_until)).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);

    await runFlowWorkerTick(h.banco.client);
    expect(corpos().at(-1)).toBe("Lembrete: o material está no grupo.");
    expect(execucao()).toMatchObject({ status: "completed" });
  });

  it("CLIQUE TARDIO durante a espera: desvia a MESMA execução para a saída do botão", async () => {
    grafo();
    await iniciar();
    const r = await responder("1");
    expect(r).toMatchObject({ status: "ok", detail: "late_click" });
    expect(corpos().at(-1)).toBe("Obrigado por confirmar!");
    expect(h.banco.tabelas.flow_executions).toHaveLength(1);
    expect(execucao()).toMatchObject({ status: "completed", listening_node_id: null, next_execution_at: null });
    // A espera cancelada não volta: o relógio não manda o lembrete.
    await runFlowWorkerTick(h.banco.client);
    expect(corpos()).not.toContain("Lembrete: o material está no grupo.");
  });

  it("CLIQUE TARDIO depois do fim: a execução é REABERTA (a mesma linha)", async () => {
    grafo();
    await iniciar();
    await runFlowWorkerTick(h.banco.client);
    expect(execucao()).toMatchObject({ status: "completed", listening_node_id: "m1" });
    const r = await responder("verificar grupo");
    expect(r).toMatchObject({ status: "ok", detail: "late_click" });
    expect(corpos().at(-1)).toBe("Obrigado por confirmar!");
    expect(h.banco.tabelas.flow_executions).toHaveLength(1);
  });

  it("resposta que não casa com botão nenhum não mexe na execução", async () => {
    grafo();
    await iniciar();
    const r = await responder("oi, tudo bem?");
    expect(r).toMatchObject({ status: "skipped" });
    expect(execucao()).toMatchObject({ status: "waiting", waiting_node_id: "espera" });
  });

  it("botão já VENCIDO não desvia", async () => {
    grafo();
    await iniciar();
    execucao().listening_until = new Date(Date.now() - 1000).toISOString();
    expect(await responder("1")).toMatchObject({ status: "skipped" });
  });

  it("execução CANCELADA (ex.: anonimização LGPD) não é reaberta pelo clique", async () => {
    grafo();
    await iniciar();
    execucao().status = "cancelled";
    expect(await responder("1")).toMatchObject({ status: "skipped" });
    expect(execucao().status).toBe("cancelled");
  });

  it("compatibilidade: sem Próximo passo ligado, o nó ESPERA o clique", async () => {
    montar(
      [
        mensagem("m1", [texto("a", "Escolha", [{ id: "ok", rotulo: "Sim", acao: "fluxo" }])]),
        mensagem("mb", [texto("b", "Escolheu sim")]),
      ],
      [
        { de: "t", para: "m1" },
        { de: "m1", para: "mb", handle: "button:ok" },
      ],
    );
    await iniciar();
    expect(execucao()).toMatchObject({ status: "waiting", waiting_for: "button_reply", waiting_node_id: "m1" });
    expect(await responder("Sim")).toMatchObject({ status: "ok", detail: "resumed" });
    expect(corpos().at(-1)).toBe("Escolheu sim");
  });

  it("a saída padrão NUNCA cai na aresta de um botão", () => {
    const graph = {
      nodesById: new Map([["mb", { id: "mb" }]]) as never,
      edgesBySource: new Map([["m1", [{ id: "e", flow_id: "f1", source_node_id: "m1", target_node_id: "mb", source_handle: "button:ok" }]]]),
    };
    expect(nextNode(graph, "m1", null)).toBeNull();
    expect(nextNode(graph, "m1", "button:ok")).toMatchObject({ id: "mb" });
  });
});

describe("formato antigo continua funcionando", () => {
  it("body + buttons: mesma lista numerada, mesma saída `button:<i>`, e espera sem Próximo passo", async () => {
    montar(
      [
        { id: "m1", type: "MESSAGE", config: { body: "Quer falar com um atendente?", buttons: [{ label: "Sim" }, { label: "Não" }] } },
        mensagem("m2", [texto("b", "Chamando alguém")]),
      ],
      [
        { de: "t", para: "m1" },
        { de: "m1", para: "m2", handle: "button:0" },
      ],
    );
    await iniciar();
    expect(corpos()).toEqual(["Quer falar com um atendente?\n1. Sim\n2. Não"]);
    expect(execucao()).toMatchObject({ status: "waiting", waiting_for: "button_reply" });
    await responder("1");
    expect(corpos().at(-1)).toBe("Chamando alguém");
  });
});

describe("a mesma estrutura no fluxo de um DISPARO", () => {
  it("blocos com atraso: o destinatário fica in_flow durante a espera e sent no fim", async () => {
    montar(
      [
        mensagem("m1", [texto("a", "Primeira"), { id: "d", tipo: "atraso", segundos: 3 }, texto("b", "Segunda")]),
      ],
      [{ de: "t", para: "m1" }],
      { disparo: true },
    );
    await runBroadcastWorkerTick(h.banco.client);
    expect(corpos()).toEqual(["Primeira"]);
    // Já recebeu uma mensagem aceita: sent — e o disparo ainda não acabou para o fluxo, mas não há pendente.
    expect(h.banco.tabelas.broadcast_recipients![0]!.status).toBe("sent");
    await runFlowWorkerTick(h.banco.client);
    expect(corpos()).toEqual(["Primeira", "Segunda"]);
    expect(execucao()).toMatchObject({ status: "completed", broadcast_recipient_id: "r1" });
  });
});

describe("validação para ativar", () => {
  it("aponta o que falta em cada bloco", () => {
    const p = problemasDosBlocos(
      {
        blocks: [
          { id: "a", tipo: "texto", texto: "", botoes: [{ id: "u", rotulo: "Site", acao: "url", url: "curso" }] },
          { id: "i", tipo: "imagem" },
          { id: "d", tipo: "atraso", segundos: 0 },
        ],
      },
      "a mensagem",
    );
    expect(p.join(" | ")).toMatch(/botão precisa de um texto acima/);
    expect(p.join(" | ")).toMatch(/endereço válido/);
    expect(p.join(" | ")).toMatch(/escolha a imagem/);
    expect(p.join(" | ")).toMatch(/1 segundo a 24 horas/);
  });

  it("só atraso não é mensagem", () => {
    expect(problemasDosBlocos({ blocks: [{ id: "d", tipo: "atraso", segundos: 3 }] }, "x")).toEqual([
      "Em x, adicione um texto ou uma imagem para enviar.",
    ]);
  });
});
