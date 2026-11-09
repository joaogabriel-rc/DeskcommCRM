import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { lerReacao } from "@/lib/messaging/reacao";
import type { Message } from "@/lib/types/messaging";

/**
 * O QUE O CANAL OFICIAL PASSOU A GRAVAR APARECE NA INBOX.
 *
 * Renderiza a bolha e lê a tela — comportamento, não fonte:
 *   - reação: o emoji e um trecho da mensagem reagida (antes a bolha ficava
 *     vazia: a reação não tem corpo);
 *   - reação removida (emoji nulo) diz isso;
 *   - localização: o cartão do mapa, a partir de `metadata.location` no formato
 *     que o parser da Meta passou a gravar;
 *   - os rótulos de tipo não suportado e de pedido aparecem como texto.
 */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: "wamid.m1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: null,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: null,
    sent_by_user_id: null,
    sent_at: "2026-11-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-11-08T12:00:00.000Z",
    ...over,
  } as Message;
}

describe("reação", () => {
  const alvo = msg({
    id: "m0",
    external_id: "wamid.alvo",
    direction: "outbound",
    body: "Seu pedido saiu para entrega",
  });

  it("mostra o emoji e o trecho da mensagem reagida", () => {
    render(
      <MessageBubble
        message={msg({
          type: "reaction",
          metadata: { reaction: { emoji: "👍", message_id: "wamid.alvo" } },
        })}
        alvoDaReacao={alvo}
      />,
    );
    expect(screen.getByTestId("reacao").textContent).toContain("👍");
    expect(screen.getByText("Reagiu a uma mensagem")).toBeTruthy();
    expect(screen.getByTestId("reacao-alvo").textContent).toBe("Seu pedido saiu para entrega");
  });

  it("reação a mensagem apagada não revela o texto apagado", () => {
    render(
      <MessageBubble
        message={msg({
          type: "reaction",
          metadata: { reaction: { emoji: "😮", message_id: "wamid.alvo" } },
        })}
        alvoDaReacao={{ ...alvo, revoked_at: "2026-11-08T12:01:00.000Z" }}
      />,
    );
    expect(screen.queryByText(/saiu para entrega/)).toBeNull();
    expect(screen.getByTestId("reacao-alvo").textContent).toBe("Esta mensagem foi apagada");
  });

  it("reação removida diz que foi removida", () => {
    render(
      <MessageBubble
        message={msg({
          type: "reaction",
          metadata: { reaction: { emoji: null, message_id: "wamid.alvo" } },
        })}
      />,
    );
    expect(screen.getByText("Removeu a reação")).toBeTruthy();
  });

  it("CONTROLE: texto comum continua só o texto, sem bloco de reação", () => {
    render(<MessageBubble message={msg({ body: "oi" })} />);
    expect(screen.queryByTestId("reacao")).toBeNull();
    expect(screen.getByText("oi")).toBeTruthy();
  });

  it("lerReacao recusa forma estranha em vez de quebrar a bolha", () => {
    expect(lerReacao({ reaction: "x" })).toBeNull();
    expect(lerReacao({ reaction: {} })).toBeNull();
    expect(lerReacao(null)).toBeNull();
  });
});

describe("localização do canal oficial", () => {
  it("o cartão aparece com nome e endereço gravados pelo parser", () => {
    const { container } = render(
      <MessageBubble
        message={msg({
          type: "location",
          metadata: {
            location: {
              latitude: -16.68,
              longitude: -49.25,
              name: "Loja Centro",
              address: "Rua 1, Goiânia",
            },
          },
        })}
      />,
    );
    expect(container.textContent).toContain("Loja Centro");
    expect(container.textContent).toContain("Rua 1, Goiânia");
  });
});

describe("rótulos do canal oficial", () => {
  it.each([
    "[Enquete — tipo de mensagem que o WhatsApp oficial não entrega ao CRM]",
    "Pedido pelo catálogo: 1 item\n• 1 × camiseta — 49.9 BRL",
  ])("aparece como texto: %s", (body) => {
    const { container } = render(<MessageBubble message={msg({ body })} />);
    expect(container.textContent).toContain(body.split("\n")[0]);
  });
});
