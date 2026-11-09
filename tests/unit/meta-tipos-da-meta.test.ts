/**
 * O PARSER DA META NÃO PERDE MENSAGEM POR TIPO — e não muda nada para os tipos
 * que já funcionavam.
 *
 * Fixtures no formato da referência oficial do webhook (developers.facebook.com,
 * business-messaging/whatsapp/webhooks/reference/messages/*): `unsupported` (os 19
 * subtipos documentados), `order`, `interactive` (mensagem da empresa com botões e
 * lista), `nfm_reply` (WhatsApp Flows), `revoke`, `edit`, `location`, `reaction`, e
 * um tipo que nenhuma documentação lista.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  parseMetaWebhook,
  type EchoMessageEvent,
  type InboundMessageEvent,
  type MessageChangeEvent,
} from "@/lib/channels/meta/webhook";
import { sanitizarMetadataDaAlteracao } from "@/lib/channels/meta/alteracao-de-mensagem";
import { ROTULO_DO_NAO_SUPORTADO } from "@/lib/channels/meta/tipos-da-meta";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

const NUM = "106540352242922";

function recebidas(...messages: Record<string, unknown>[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: NUM },
              contacts: [{ wa_id: "5562988887777", profile: { name: "Cliente" } }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

function ecos(...message_echoes: Record<string, unknown>[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: NUM },
              message_echoes,
            },
          },
        ],
      },
    ],
  };
}

const base = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  from: "5562988887777",
  id,
  timestamp: "1749416383",
  type,
  ...extra,
});
const umaRecebida = (item: Record<string, unknown>) =>
  parseMetaWebhook(recebidas(item) as never)[0] as InboundMessageEvent;
const umEco = (item: Record<string, unknown>) =>
  parseMetaWebhook(ecos({ to: "5562988887777", ...item }) as never)[0] as EchoMessageEvent;

describe("tipos que já funcionavam não mudam", () => {
  it("texto", () => {
    const e = umaRecebida(base("wamid.t", "text", { text: { body: "Oi, tudo bem?" } }));
    expect(e).toMatchObject({
      kind: "inbound_message",
      type: "text",
      text: "Oi, tudo bem?",
      media: null,
    });
    // A mensagem comum sai com o MESMO formato de antes: sem `extras` nem marca.
    expect(e.extras).toBeUndefined();
    expect(e.conteudoIndisponivel).toBeUndefined();
  });

  it.each(["image", "video", "audio", "document", "sticker"])(
    "%s continua mídia, sem texto",
    (tipo) => {
      const e = umaRecebida(
        base(`wamid.${tipo}`, tipo, {
          [tipo]: { id: "midia-1", mime_type: "x/y", voice: tipo === "audio" },
        }),
      );
      expect(e).toMatchObject({ type: tipo, text: null, media: { id: "midia-1", mime: "x/y" } });
      expect(e.extras).toBeUndefined();
      expect(e.conteudoIndisponivel).toBeUndefined();
    },
  );

  it("cartão de contato continua `contact`", () => {
    const e = umaRecebida(
      base("wamid.c", "contacts", {
        contacts: [{ name: { formatted_name: "Fulano" }, phones: [{ phone: "+55 62 9999-0000" }] }],
      }),
    );
    expect(e.type).toBe("contact");
  });

  it("resposta de botão e de lista continuam texto com o rótulo", () => {
    expect(
      umaRecebida(base("wamid.b", "button", { button: { text: "Quero", payload: "QUERO" } })),
    ).toMatchObject({ type: "text", text: "Quero" });
    expect(
      umaRecebida(
        base("wamid.l", "interactive", {
          interactive: { type: "list_reply", list_reply: { id: "x", title: "Plano B" } },
        }),
      ),
    ).toMatchObject({ type: "text", text: "Plano B" });
  });
});

describe("todo evento de mensagem leva o original da Meta", () => {
  it("o item cru, com chaves que o parser não lê, fica em `bruto`", () => {
    const item = base("wamid.o", "text", {
      text: { body: "oi" },
      context: { from: "x", id: "wamid.antes" },
      campo_novo_da_meta: { a: 1 },
    });
    expect(umaRecebida(item).bruto).toEqual(item);
    expect(
      umEco({
        id: "wamid.eo",
        timestamp: "1",
        type: "text",
        text: { body: "oi" },
        campo_novo: true,
      }).bruto,
    ).toMatchObject({ campo_novo: true });
  });
});

describe("unsupported — registrado, com rótulo, sem conteúdo inventado", () => {
  it.each(Object.entries(ROTULO_DO_NAO_SUPORTADO))(
    "subtipo %s vira texto com o rótulo dele",
    (subtipo, rotulo) => {
      const e = umaRecebida(
        base(`wamid.u.${subtipo}`, "unsupported", {
          errors: [
            {
              code: 131051,
              title: "Message type unknown",
              message: "Message type unknown",
              error_data: { details: "Message type is currently not supported." },
            },
          ],
          unsupported: { type: subtipo },
        }),
      );
      expect(e.type).toBe("text");
      expect(e.text?.toLowerCase()).toContain(rotulo.toLowerCase());
      expect(e.conteudoIndisponivel).toBe(true);
      expect(e.extras).toMatchObject({
        meta_tipo: "unsupported",
        unsupported: { type: subtipo, errors: [expect.objectContaining({ code: 131051 })] },
      });
    },
  );

  it("131060 (mensagem ainda indisponível) diz isso, e não que o tipo é inválido", () => {
    const e = umaRecebida(
      base("wamid.u60", "unsupported", {
        errors: [{ code: 131060, title: "This message is currently unavailable." }],
        unsupported: { type: "image" },
      }),
    );
    expect(e.text).toMatch(/indisponível no momento/);
  });

  it("subtipo fora da documentação cai no rótulo genérico", () => {
    expect(
      umaRecebida(base("wamid.ux", "unsupported", { unsupported: { type: "novidade" } })).text,
    ).toMatch(/não entrega ao CRM/);
  });

  it("nenhum rótulo gerado pelo CRM aciona a detecção de opt-out", () => {
    const rotulos = [
      ...Object.keys(ROTULO_DO_NAO_SUPORTADO).map(
        (s) => umaRecebida(base(`wamid.${s}`, "unsupported", { unsupported: { type: s } })).text,
      ),
      umaRecebida(base("wamid.g", "unsupported", {})).text,
      umaRecebida(base("wamid.i", "unsupported", { errors: [{ code: 131060 }] })).text,
      umaRecebida(base("wamid.x", "tipo_inventado")).text,
      umaRecebida(base("wamid.p", "order", { order: { catalog_id: "c", product_items: [] } })).text,
    ];
    for (const r of rotulos) expect(ehPedidoDeOptOut(r), r ?? "").toBe(false);
  });
});

describe("order — pedido pelo catálogo, legível e inteiro", () => {
  it("vira texto com os itens, e o pedido original fica em extras.order", () => {
    const order = {
      catalog_id: "1537160263780324",
      text: "Entregar à tarde",
      product_items: [
        { product_retailer_id: "camiseta-p", quantity: 2, item_price: 49.9, currency: "BRL" },
        { product_retailer_id: "bone", quantity: 1, item_price: 30, currency: "BRL" },
      ],
    };
    const e = umaRecebida(base("wamid.ord", "order", { order }));
    expect(e.type).toBe("text");
    expect(e.text).toContain("Pedido pelo catálogo: 2 itens");
    expect(e.text).toContain("2 × camiseta-p — 49.9 BRL");
    expect(e.text).toContain("Entregar à tarde");
    expect(e.extras).toEqual({ meta_tipo: "order", order });
    // Cliente comprando segue o fluxo normal.
    expect(e.conteudoIndisponivel).toBeUndefined();
  });
});

describe("interactive da empresa (eco do app) — corpo, cabeçalho, rodapé, botões e lista", () => {
  it("botões", () => {
    const interactive = {
      type: "button",
      header: { type: "text", text: "Promoção" },
      body: { text: "Quer receber o catálogo?" },
      footer: { text: "Loja X" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "sim", title: "Sim" } },
          { type: "reply", reply: { id: "nao", title: "Agora não" } },
        ],
      },
    };
    const e = umEco({ id: "wamid.ib", timestamp: "1749416383", type: "interactive", interactive });
    expect(e.type).toBe("text");
    expect(e.text).toBe("Promoção\nQuer receber o catálogo?\nLoja X\n[Sim]\n[Agora não]");
    expect(e.extras).toEqual({ meta_tipo: "interactive", interactive });
    expect(e.conteudoIndisponivel).toBeUndefined();
  });

  it("lista com seções", () => {
    const e = umEco({
      id: "wamid.il",
      timestamp: "1",
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Escolha" },
        action: {
          button: "Ver opções",
          sections: [
            {
              title: "Planos",
              rows: [
                { id: "a", title: "Básico", description: "R$ 10" },
                { id: "b", title: "Pro" },
              ],
            },
          ],
        },
      },
    });
    expect(e.text).toBe("Escolha\n[Ver opções]\nPlanos:\n• Básico — R$ 10\n• Pro");
  });
});

describe("nfm_reply — resposta de formulário do WhatsApp Flows", () => {
  it("vira 'campo: valor' legível, sem o flow_token, e o original fica em extras.flow", () => {
    const e = umaRecebida(
      base("wamid.nfm", "interactive", {
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: JSON.stringify({
              flow_token: "segredo",
              nome: "Ana",
              data: "2026-11-10",
            }),
          },
        },
      }),
    );
    expect(e.type).toBe("text");
    expect(e.text).toContain("• nome: Ana");
    expect(e.text).toContain("• data: 2026-11-10");
    expect(e.text).not.toContain("segredo");
    expect(e.extras).toMatchObject({
      meta_tipo: "nfm_reply",
      flow: { name: "flow", response: { nome: "Ana", flow_token: "segredo" } },
    });
  });

  it("response_json inválido não derruba a mensagem", () => {
    const e = umaRecebida(
      base("wamid.nfm2", "interactive", {
        interactive: { type: "nfm_reply", nfm_reply: { body: "Sent", response_json: "{quebrado" } },
      }),
    );
    expect(e).toMatchObject({ type: "text" });
    expect(e.text).toContain("Sent");
  });
});

describe("tipo desconhecido — nunca rejeitado", () => {
  it("vira texto com rótulo, marcado sem conteúdo", () => {
    const e = umaRecebida(base("wamid.z", "hologram", { hologram: { x: 1 } }));
    expect(e).toMatchObject({
      type: "text",
      conteudoIndisponivel: true,
      extras: { meta_tipo: "hologram" },
    });
    expect(e.text).toContain("hologram");
  });
});

describe("localização e reação", () => {
  it("localização guarda coordenadas, nome, endereço e link em extras.location", () => {
    const e = umaRecebida(
      base("wamid.loc", "location", {
        location: {
          latitude: -16.68,
          longitude: -49.25,
          name: "Loja",
          address: "Rua 1",
          url: "https://x",
        },
      }),
    );
    expect(e.type).toBe("location");
    expect(e.extras).toEqual({
      location: {
        latitude: -16.68,
        longitude: -49.25,
        name: "Loja",
        address: "Rua 1",
        url: "https://x",
      },
    });
  });

  it("reação guarda o emoji e o wamid da mensagem reagida; removida vira emoji null", () => {
    expect(
      umaRecebida(
        base("wamid.r1", "reaction", { reaction: { message_id: "wamid.alvo", emoji: "👍" } }),
      ).extras,
    ).toEqual({ reaction: { emoji: "👍", message_id: "wamid.alvo" } });
    expect(
      umaRecebida(base("wamid.r2", "reaction", { reaction: { message_id: "wamid.alvo" } })).extras,
    ).toEqual({ reaction: { emoji: null, message_id: "wamid.alvo" } });
  });
});

describe("revoke e edit — alteração da original, do contato e da empresa", () => {
  it("revoke do contato", () => {
    const [e] = parseMetaWebhook(
      recebidas({
        from: "5562988887777",
        id: "wamid.rv",
        timestamp: "1749416383",
        type: "revoke",
        revoke: { original_message_id: "wamid.orig" },
      }) as never,
    ) as MessageChangeEvent[];
    expect(e).toMatchObject({
      kind: "message_change",
      acao: "revoke",
      origem: "contato",
      originalId: "wamid.orig",
      externalId: "wamid.rv",
      phoneNumberId: NUM,
      novoTexto: null,
    });
  });

  it("revoke sem `from` (usuário com nome de usuário) continua valendo", () => {
    const [e] = parseMetaWebhook(
      recebidas({
        from_user_id: "BR.1",
        id: "wamid.rv2",
        timestamp: "1",
        type: "revoke",
        revoke: { original_message_id: "wamid.orig" },
      }) as never,
    );
    expect(e?.kind).toBe("message_change");
  });

  it("edit do contato traz o texto novo; edit de mídia traz a legenda", () => {
    const [t] = parseMetaWebhook(
      recebidas({
        id: "wamid.ed",
        timestamp: "1",
        type: "edit",
        edit: {
          original_message_id: "wamid.orig",
          message: { type: "text", text: { body: "Corrigido" } },
        },
      }) as never,
    ) as MessageChangeEvent[];
    expect(t).toMatchObject({ acao: "edit", novoTexto: "Corrigido" });
    const [m] = parseMetaWebhook(
      recebidas({
        id: "wamid.ed2",
        timestamp: "1",
        type: "edit",
        edit: {
          original_message_id: "wamid.orig",
          message: { type: "image", image: { caption: "Nova legenda" } },
        },
      }) as never,
    ) as MessageChangeEvent[];
    expect(m?.novoTexto).toBe("Nova legenda");
  });

  it("revoke e edit da empresa pelo app viram alteração com origem 'empresa'", () => {
    const eventos = parseMetaWebhook(
      ecos(
        {
          to: "5562988887777",
          id: "wamid.erv",
          timestamp: "1",
          type: "revoke",
          revoke: { original_message_id: "wamid.nossa" },
        },
        {
          to: "5562988887777",
          id: "wamid.eed",
          timestamp: "1",
          type: "edit",
          edit: {
            original_message_id: "wamid.nossa",
            message: { type: "text", text: { body: "Ajustado" } },
          },
        },
      ) as never,
    ) as MessageChangeEvent[];
    expect(eventos.map((e) => [e.kind, e.acao, e.origem])).toEqual([
      ["message_change", "revoke", "empresa"],
      ["message_change", "edit", "empresa"],
    ]);
    expect(eventos[1]?.novoTexto).toBe("Ajustado");
  });

  it("sem original_message_id não há o que alterar: nenhum evento, nenhuma linha", () => {
    expect(
      parseMetaWebhook(
        recebidas({ id: "wamid.x", timestamp: "1", type: "revoke", revoke: {} }) as never,
      ),
    ).toEqual([]);
    expect(
      parseMetaWebhook(
        ecos({ to: "1", id: "wamid.y", timestamp: "1", type: "edit", edit: {} }) as never,
      ),
    ).toEqual([]);
  });
});

describe("sanitizarMetadataDaAlteracao — a regra pura", () => {
  const base = {
    meta_original: {
      id: "w",
      from: "55",
      timestamp: "1",
      type: "text",
      text: { body: "segredo" },
      context: { id: "p", from: "x", forwarded: true },
      extra: { a: "segredo" },
    },
    location: { latitude: 1, longitude: 2, name: "segredo" },
    meta_media_id: "midia-1",
    origem: "whatsapp_business_app",
  };

  it("é idempotente", () => {
    const uma = sanitizarMetadataDaAlteracao(base, "revoke");
    expect(sanitizarMetadataDaAlteracao(uma, "revoke")).toEqual(uma);
    const edit = sanitizarMetadataDaAlteracao(base, "edit");
    expect(sanitizarMetadataDaAlteracao(edit, "edit")).toEqual(edit);
  });

  it("edit: o original fica só com o estrutural; ponteiros e marcas do CRM ficam", () => {
    const m = sanitizarMetadataDaAlteracao(base, "edit");
    expect(m.meta_original).toEqual({
      id: "w",
      from: "55",
      timestamp: "1",
      type: "text",
      context: { id: "p", from: "x" },
    });
    expect(m).toMatchObject({
      meta_media_id: "midia-1",
      origem: "whatsapp_business_app",
      meta_original_sanitizado: "edit",
    });
  });

  it("revoke: sem o conteúdo e sem as cópias derivadas", () => {
    const m = sanitizarMetadataDaAlteracao(base, "revoke");
    expect(JSON.stringify(m)).not.toContain("segredo");
    expect(m.location).toBeUndefined();
    expect(m.meta_original_sanitizado).toBe("revoke");
  });

  it("revoke depois de edit fica marcado como revoke; edit depois de revoke não desmarca", () => {
    const editada = sanitizarMetadataDaAlteracao(base, "edit");
    expect(sanitizarMetadataDaAlteracao(editada, "revoke").meta_original_sanitizado).toBe("revoke");
    const apagada = sanitizarMetadataDaAlteracao(base, "revoke");
    expect(sanitizarMetadataDaAlteracao(apagada, "edit").meta_original_sanitizado).toBe("revoke");
  });

  it("mensagem sem original guardado e metadata nulo não quebram", () => {
    expect(sanitizarMetadataDaAlteracao(null, "edit")).toEqual({
      meta_original_sanitizado: "edit",
    });
    expect(sanitizarMetadataDaAlteracao({ crm_hidden_at: "t" }, "revoke")).toEqual({
      crm_hidden_at: "t",
      meta_original_sanitizado: "revoke",
    });
  });
});
