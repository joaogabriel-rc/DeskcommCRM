import { describe, expect, it } from "vitest";

import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

/**
 * Coexistência: o que a empresa manda pelo app WhatsApp Business entra no CRM.
 *
 * A Meta entrega essas mensagens no campo `smb_message_echoes`, que o parser
 * descartava — a conversa ficava sem as respostas dadas pelo celular e o agente
 * respondia por cima de um humano. O formato do payload é o da referência da
 * Meta (webhooks/reference/smb_message_echoes).
 *
 * ── Uma implementação do eco, não duas ──────────────────────────────────────
 * Este arquivo nasceu na upstream com a leitura `outbound_echo`, e a produção
 * tinha a sua (`echo_message`, com a quarentena de ecos e a sincronização do
 * app). No merge ficou a da produção — é a que roda, e o banco já tem as tabelas
 * dela. O que só a leitura da upstream fazia (legenda da mídia como texto e
 * `revoke`/`edit` fora) foi portado para `ecoDoItem`, e é o que estes casos do
 * PARSER seguem vigiando. A ingestão do eco é medida pelos testes da produção:
 * `meta-eco-do-app-business`, `meta-ecos-em-espera`, `meta-sincronizacao-do-app`.
 */

function envelopeDeEcos(ecos: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511300000000", phone_number_id: "phone-1" },
              message_echoes: ecos,
            },
          },
        ],
      },
    ],
  };
}

describe("parser: smb_message_echoes vira evento de saída", () => {
  it("texto enviado pelo app vira `echo_message` com o cliente em `to`", () => {
    const eventos = parseMetaWebhook(
      envelopeDeEcos([
        {
          from: "5511300000000",
          to: "5519999999999",
          id: "wamid.ECO1",
          timestamp: "1790000000",
          type: "text",
          text: { body: "Olá, tudo bem?" },
        },
      ]) as never,
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      kind: "echo_message",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      externalId: "wamid.ECO1",
      to: "5519999999999",
      sentAt: new Date(1790000000 * 1000),
      type: "text",
      text: "Olá, tudo bem?",
      media: null,
    });
  });

  it("mídia enviada pelo app traz o ponteiro e a legenda como texto", () => {
    const [e] = parseMetaWebhook(
      envelopeDeEcos([
        {
          to: "5519999999999",
          id: "wamid.ECO2",
          timestamp: "1790000000",
          type: "image",
          image: { id: "media-9", mime_type: "image/jpeg", caption: "segue a foto" },
        },
      ]) as never,
    );
    expect(e).toMatchObject({
      kind: "echo_message",
      type: "image",
      text: "segue a foto",
      media: { id: "media-9", mime: "image/jpeg", url: null, voice: false },
    });
  });

  it("cartão de contato (`contacts`) vira `contact` com o nome, como na recebida", () => {
    // O CHECK de `messages.type` aceita `contact`, não `contacts`: sem o mapeamento
    // o insert falharia e a IA não pausaria.
    const [e] = parseMetaWebhook(
      envelopeDeEcos([
        {
          to: "5519999999999",
          id: "wamid.ECO3",
          timestamp: "1790000000",
          type: "contacts",
          contacts: [{ name: { formatted_name: "Ana Souza" }, phones: [{ phone: "+55 11 98888-7777" }] }],
        },
      ]) as never,
    );
    expect(e).toMatchObject({
      kind: "echo_message",
      type: "contact",
      text: "Ana Souza",
      sharedContact: { name: "Ana Souza" },
      media: null,
    });
  });

  it("`revoke`, `edit` e eco sem destinatário ficam de fora", () => {
    const eventos = parseMetaWebhook(
      envelopeDeEcos([
        { to: "5519999999999", id: "wamid.R", timestamp: "1", type: "revoke", revoke: {} },
        { to: "5519999999999", id: "wamid.E", timestamp: "1", type: "edit", edit: {} },
        { id: "wamid.SEM_TO", timestamp: "1", type: "text", text: { body: "x" } },
      ]) as never,
    );
    expect(eventos).toEqual([]);
  });
});
