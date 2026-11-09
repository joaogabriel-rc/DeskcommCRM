/**
 * CERCA: nenhum tipo que o parser da Meta produz pode cair fora de
 * `messages_type_check`.
 *
 * O defeito que isto prende: o parser repassava o `type` cru da Meta e o banco
 * recusava (23514). Entre 01 e 08/11/2026 foram 183 mensagens perdidas assim na
 * produção — `unsupported`, `interactive`, `revoke`, `edit`, `order`.
 *
 * Duas pontas, e a cerca olha as duas:
 *   - a lista fechada `TIPOS_QUE_O_PARSER_PRODUZ` tem de caber na ÚLTIMA
 *     definição da constraint no baseline (é a que o banco instala — o arquivo
 *     é aplicado inteiro e em ordem, e a constraint aparece mais de uma vez);
 *   - o parser, alimentado com TODO tipo documentado pela Meta e com tipos
 *     inventados, só pode devolver valores daquela lista.
 * Se alguém mudar a constraint ou acrescentar um ramo no parser sem a outra
 * ponta, isto reprova antes de a mensagem sumir.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import {
  ROTULO_DO_NAO_SUPORTADO,
  TIPOS_QUE_O_PARSER_PRODUZ,
} from "@/lib/channels/meta/tipos-da-meta";

/** Os valores da ÚLTIMA `add constraint messages_type_check` do baseline. */
function tiposAceitosPeloBanco(): string[] {
  const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const marca = "add constraint messages_type_check";
  const inicio = baseline.lastIndexOf(marca);
  expect(inicio, "a constraint não foi achada no baseline — a cerca perdeu o alvo").toBeGreaterThan(
    0,
  );
  const fim = baseline.indexOf("]", inicio);
  const trecho = baseline
    .slice(inicio, fim)
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return [...trecho.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

const TODOS_OS_TIPOS_DA_META = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contacts",
  "reaction",
  "system",
  "button",
  "interactive",
  "order",
  "unsupported",
  "unknown",
  "request_welcome",
  "ephemeral",
  "poll",
  "tipo_que_a_meta_ainda_nao_inventou",
];

function entrega(
  itens: Record<string, unknown>[],
  campo: "messages" | "smb_message_echoes" = "messages",
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: campo,
            value: {
              metadata: { phone_number_id: "numero-1" },
              ...(campo === "messages" ? { messages: itens } : { message_echoes: itens }),
            },
          },
        ],
      },
    ],
  };
}

function itemDoTipo(tipo: string, i: number): Record<string, unknown> {
  return {
    id: `wamid.${i}`,
    from: "5562999990000",
    to: "5562999990000",
    timestamp: "1790000000",
    type: tipo,
    [tipo]: {},
  };
}

describe("cerca — tipos do parser x messages_type_check", () => {
  const aceitos = tiposAceitosPeloBanco();

  it("a constraint lida do baseline é a atual (tem o vocabulário conhecido)", () => {
    expect(aceitos).toEqual(
      expect.arrayContaining(["text", "image", "reaction", "system", "template"]),
    );
  });

  it("todo tipo da lista fechada do parser é aceito pelo banco", () => {
    const fora = TIPOS_QUE_O_PARSER_PRODUZ.filter((t) => !aceitos.includes(t));
    expect(fora).toEqual([]);
  });

  it.each(["messages", "smb_message_echoes"] as const)(
    "o parser (%s), com todo tipo da Meta e tipos inventados, só devolve tipos aceitos",
    (campo) => {
      const itens = [
        ...TODOS_OS_TIPOS_DA_META.map(itemDoTipo),
        ...Object.keys(ROTULO_DO_NAO_SUPORTADO).map((sub, i) => ({
          ...itemDoTipo("unsupported", 100 + i),
          unsupported: { type: sub },
          errors: [{ code: 131051, title: "Message type unknown" }],
        })),
        {
          ...itemDoTipo("interactive", 200),
          interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } },
        },
        {
          ...itemDoTipo("interactive", 201),
          interactive: { type: "button_reply", button_reply: { id: "a", title: "Sim" } },
        },
        { ...itemDoTipo("button", 202), button: { text: "Quero" } },
        { ...itemDoTipo("button", 203), button: {} },
      ];
      const tipos = parseMetaWebhook(entrega(itens, campo) as never)
        .filter((e) => e.kind === "inbound_message" || e.kind === "echo_message")
        .map((e) => (e as { type: string }).type);
      expect(tipos.length).toBeGreaterThanOrEqual(itens.length);
      expect([...new Set(tipos)].filter((t) => !aceitos.includes(t))).toEqual([]);
    },
  );

  it("revoke e edit nunca viram linha de mensagem — viram alteração", () => {
    const eventos = parseMetaWebhook(
      entrega([
        {
          id: "wamid.r",
          timestamp: "1790000000",
          type: "revoke",
          revoke: { original_message_id: "wamid.o" },
        },
        {
          id: "wamid.e",
          timestamp: "1790000000",
          type: "edit",
          edit: {
            original_message_id: "wamid.o",
            message: { type: "text", text: { body: "novo" } },
          },
        },
      ]) as never,
    );
    expect(eventos.map((e) => e.kind)).toEqual(["message_change", "message_change"]);
  });
});
