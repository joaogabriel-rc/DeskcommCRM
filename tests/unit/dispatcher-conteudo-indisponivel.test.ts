/**
 * MENSAGEM SEM CONTEÚDO NÃO RECEBE RESPOSTA AUTOMÁTICA.
 *
 * O WhatsApp oficial manda mensagens cujo conteúdo a Cloud API não entrega
 * (`unsupported`). O CRM as grava como texto com um RÓTULO dele mesmo e a
 * migration 9254 põe `conteudo_indisponivel: true` no payload do evento. O
 * dispatcher pula, como `skipped`, os handlers que respondem ao conteúdo — e
 * só eles: quem avisa o atendente ou registra que o cliente respondeu continua.
 *
 * Divisão aprovada pelo dono do produto (08/11/2026):
 *   bloqueados → flow-reply, flow-trigger, automation-rules, ai-response-worker, ai-sentiment-worker
 *   mantidos   → web-push-inbound, followup-reactivity, campanha-resposta, followup-gatilho-retorno
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import {
  dispatchEvent,
  getRegisteredHandlers,
  registerHandler,
  type EventHandler,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

function evento(payload: Record<string, unknown>, consumed_by: string[] = []): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m-1",
    payload: {
      message_id: "m-1",
      type: "text",
      body_preview: "[Enquete — tipo de mensagem que o WhatsApp oficial não entrega ao CRM]",
      ...payload,
    },
    metadata: {},
    consumed_by,
    attempts: 0,
  };
}

describe("guarda do dispatcher", () => {
  const responde = vi.fn(async () => ({ consumer_key: "teste-responde", status: "ok" as const }));
  const registra = vi.fn(async () => ({ consumer_key: "teste-registra", status: "ok" as const }));

  beforeEach(() => {
    responde.mockClear();
    registra.mockClear();
    const h1: EventHandler = {
      key: "teste-responde",
      events: ["message.received"],
      respondeAoConteudo: true,
      handle: responde,
    };
    const h2: EventHandler = {
      key: "teste-registra",
      events: ["message.received"],
      handle: registra,
    };
    registerHandler(h1);
    registerHandler(h2);
  });

  it("com a marca: quem responde é pulado como skipped, sem ser chamado; quem registra roda", async () => {
    const r = await dispatchEvent(evento({ conteudo_indisponivel: true }));
    expect(responde).not.toHaveBeenCalled();
    expect(registra).toHaveBeenCalledTimes(1);
    expect(r).toEqual(
      expect.arrayContaining([
        { consumer_key: "teste-responde", status: "skipped", detail: "conteudo_indisponivel" },
        expect.objectContaining({ consumer_key: "teste-registra", status: "ok" }),
      ]),
    );
  });

  it("sem a marca (mensagem normal), nada muda: os dois rodam", async () => {
    await dispatchEvent(evento({}));
    expect(responde).toHaveBeenCalledTimes(1);
    expect(registra).toHaveBeenCalledTimes(1);
  });

  it("só `true` de verdade bloqueia — string, número ou ausência não", async () => {
    for (const v of ["true", 1, null, false]) {
      responde.mockClear();
      await dispatchEvent(evento({ conteudo_indisponivel: v }));
      expect(responde, String(v)).toHaveBeenCalledTimes(1);
    }
  });

  it("handler já em consumed_by não é chamado nem reemitido como skipped", async () => {
    const r = await dispatchEvent(evento({ conteudo_indisponivel: true }, ["teste-responde"]));
    expect(r.map((x) => x.consumer_key)).not.toContain("teste-responde");
  });
});

describe("a divisão aprovada vale nos handlers REAIS do produto", () => {
  ensureHandlersRegistered();
  const porChave = new Map(getRegisteredHandlers().map((h) => [h.key, h]));

  it.each([
    "flow-reply.v1",
    "flow-trigger.v1",
    "automation-rules",
    "ai-response-worker.v1",
    "ai-sentiment-worker.v1",
  ])("%s responde ao conteúdo e é bloqueado", (chave) => {
    const h = porChave.get(chave);
    expect(h, `handler ${chave} não registrado`).toBeDefined();
    expect(h!.respondeAoConteudo).toBe(true);
  });

  it.each([
    "web-push-inbound.v1",
    "followup-reactivity.v1",
    "campanha-resposta.v1",
    "followup-gatilho-retorno.v1",
  ])("%s só registra a chegada e continua rodando", (chave) => {
    const h = porChave.get(chave);
    expect(h, `handler ${chave} não registrado`).toBeDefined();
    expect(h!.respondeAoConteudo).toBeFalsy();
  });

  it("nenhum outro handler de message.received ganhou a marca sem decisão", () => {
    const marcados = getRegisteredHandlers()
      .filter((h) => h.respondeAoConteudo && !h.key.startsWith("teste-"))
      .map((h) => h.key)
      .sort();
    expect(marcados).toEqual([
      "ai-response-worker.v1",
      "ai-sentiment-worker.v1",
      "automation-rules",
      "flow-reply.v1",
      "flow-trigger.v1",
    ]);
  });
});
