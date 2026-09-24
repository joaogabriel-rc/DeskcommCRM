import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { configDoModeloEscolhido } from "@/hooks/channels/useCatalogoDeModelos";
import { modeloDaLinha } from "@/lib/channels/catalogo-de-modelos";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import { resumeWithButtonReply } from "@/lib/flows/engine";
import type { FlowExecutionRow } from "@/lib/flows/types";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * O BOTÃO DO MODELO APROVADO LEVA O CONTATO PELA SAÍDA CERTA DO FLUXO.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * Quem toca numa resposta rápida de modelo aprovado não manda `type: "text"`:
 * a Meta entrega `type: "button"` com `{ button: { text, payload } }`. O parser
 * só preenchia o texto de `type === "text"` e repassava o tipo cru — e `button`
 * não está no CHECK de `messages.type`. O INSERT falhava, o clique se perdia, e
 * o fluxo que esperava a resposta ficava esperando para sempre.
 *
 * ═══ A cadeia inteira, sem sistema novo de resposta ═════════════════════════
 *
 *   webhook `button` → parser devolve TEXTO com o rótulo tocado
 *   → o nó guarda as respostas rápidas do modelo como `buttons` (a escolha)
 *   → `resumeWithButtonReply` casa pelo MESMO `casarRespostaDeBotao`
 *   → a execução segue pela aresta `button:<i>`.
 */

function envelope(mensagem: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn-1" },
              contacts: [{ wa_id: "5511999990000", profile: { name: "Ana" } }],
              messages: [{ id: "wamid.1", from: "5511999990000", timestamp: "1790000000", ...mensagem }],
            },
          },
        ],
      },
    ],
  } as never;
}

function inbound(mensagem: Record<string, unknown>) {
  const [evento] = parseMetaWebhook(envelope(mensagem));
  return evento as { kind: string; type: string; text: string | null; media: unknown };
}

describe("o parser da Meta: resposta a botão vira TEXTO com o rótulo tocado", () => {
  it("type=button (resposta rápida de modelo aprovado)", () => {
    const e = inbound({ type: "button", button: { text: "Parar mensagens", payload: "Parar mensagens" } });
    expect(e).toMatchObject({ kind: "inbound_message", type: "text", text: "Parar mensagens", media: null });
  });

  it("type=interactive · button_reply", () => {
    const e = inbound({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Sim" } } });
    expect(e).toMatchObject({ type: "text", text: "Sim", media: null });
  });

  it("type=interactive · list_reply", () => {
    const e = inbound({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l2", title: "Plano anual" } } });
    expect(e).toMatchObject({ type: "text", text: "Plano anual" });
  });

  it("sem rótulo, cai para o identificador — a resposta não some", () => {
    expect(inbound({ type: "button", button: { payload: "CONFIRMAR" } }).text).toBe("CONFIRMAR");
  });

  it("controle: texto comum continua igual, e mídia continua mídia", () => {
    expect(inbound({ type: "text", text: { body: "oi" } })).toMatchObject({ type: "text", text: "oi" });
    const imagem = inbound({ type: "image", image: { id: "m1", mime_type: "image/jpeg" } });
    expect(imagem.type).toBe("image");
    expect(imagem.media).toMatchObject({ id: "m1" });
  });
});

describe("da resposta do modelo à saída do fluxo, pelo motor de verdade", () => {
  const ORG = "org-1";
  const FLUXO = "flow-1";

  const modelo = modeloDaLinha({
    id: "tpl-1", waba_id: "waba-1", channel_session_id: null, name: "confirmacao", language: "pt_BR", status: "APPROVED",
    category: "UTILITY", rejected_reason: null, quality_score: null, parameter_format: "POSITIONAL", contract_hash: "h",
    synced_at: "x",
    components: [
      { type: "BODY", text: "Podemos confirmar?" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }, { type: "QUICK_REPLY", text: "Parar mensagens" }] },
    ],
  });
  const configDoNo: Record<string, unknown> = { window_mode: "outside_24h", ...configDoModeloEscolhido(modelo, "sess-1", {}) };

  function montar() {
    return criarBanco({
      flow_nodes: [
        { id: "msg", organization_id: ORG, flow_id: FLUXO, type: "MESSAGE", label: "", config: configDoNo },
        { id: "fim-confirmou", organization_id: ORG, flow_id: FLUXO, type: "END", label: "", config: {} },
        { id: "fim-parou", organization_id: ORG, flow_id: FLUXO, type: "END", label: "", config: {} },
      ],
      flow_edges: [
        { id: "e0", organization_id: ORG, flow_id: FLUXO, source_node_id: "msg", target_node_id: "fim-confirmou", source_handle: "button:0" },
        { id: "e1", organization_id: ORG, flow_id: FLUXO, source_node_id: "msg", target_node_id: "fim-parou", source_handle: "button:1" },
      ],
      flow_executions: [
        {
          id: "exec-1", organization_id: ORG, flow_id: FLUXO, contact_id: "c-1", conversation_id: null, status: "waiting",
          current_node_id: "msg", waiting_for: "button_reply", waiting_node_id: "msg", context: {}, trigger_event_id: null,
          next_execution_at: null, attempts: 0, last_error: null,
        },
      ],
      flow_execution_events: [],
    });
  }

  it("as respostas rápidas do modelo são as saídas do nó, na ordem", () => {
    expect(configDoNo.buttons).toEqual([{ label: "Confirmar" }, { label: "Parar mensagens" }]);
  });

  it("tocar 'Parar mensagens' segue pela aresta button:1 — e não pela primeira", async () => {
    const banco = montar();
    const texto = inbound({ type: "button", button: { text: "Parar mensagens", payload: "Parar mensagens" } }).text!;
    const exec = banco.tabelas.flow_executions![0] as unknown as FlowExecutionRow;

    const r = await resumeWithButtonReply(banco.client, exec, texto);

    expect(r.matched).toBe(true);
    const depois = banco.tabelas.flow_executions![0]!;
    expect(depois.current_node_id).toBe("fim-parou");
    expect(depois.status).toBe("completed");
    const retomada = banco.tabelas.flow_execution_events!.find((e) => e.event_type === "resumed");
    expect(retomada?.payload).toMatchObject({ option_index: 1 });
  });

  it("controle: texto que não é nenhum botão não avança", async () => {
    const banco = montar();
    const exec = banco.tabelas.flow_executions![0] as unknown as FlowExecutionRow;
    expect((await resumeWithButtonReply(banco.client, exec, "qual o horário?")).matched).toBe(false);
    expect(banco.tabelas.flow_executions![0]!.status).toBe("waiting");
  });
});
