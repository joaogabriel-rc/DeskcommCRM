/**
 * GET|POST /api/v1/webhooks/meta — o webhook UNIVERSAL: um endereço para todos os
 * tenants, e a organização descoberta pelo número (`value.metadata.phone_number_id`)
 * de cada evento.
 *
 * Rodam DE VERDADE: a rota, a assinatura HMAC, o contrato do envelope, o parser, as
 * buscas de sessão e o processador compartilhado. Dublê só no banco, no App da Meta
 * da instalação e na ingestão (que tem os próprios testes).
 *
 * O que cada bloco tranca:
 *   - handshake: só com o verify token da instalação, e em texto puro;
 *   - assinatura e contrato: nada do corpo é lido antes de a assinatura conferir;
 *   - roteamento: o evento vai para a organização DONA do número, e só para ela;
 *   - isolamento: uma entrega com números de duas organizações escreve em cada uma
 *     com o `organization_id` dela; número desconhecido, arquivado ou ambíguo não
 *     escreve em ninguém;
 *   - falha de banco vira 5xx (a Meta reentrega) em vez de mensagem perdida com 200.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "app-secret-da-instalacao-de-teste";
const VERIFY = "verify-token-da-instalacao";

vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn() }));
vi.mock("@/lib/channels/meta/ingest", () => ({ ingestMetaInbound: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { GET, POST } from "@/app/api/v1/webhooks/meta/route";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta } from "@/lib/channels/meta/app";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NUM_A = "100000000000001";
const NUM_B = "100000000000002";
const WABA_A = "200000000000001";
const WABA_B = "200000000000002";

type Linha = Record<string, unknown>;
interface Escrita {
  tabela: string;
  patch: Linha;
  filtros: Record<string, unknown>;
}

let sessoes: Linha[];
let escritas: Escrita[];
let falharConsulta: boolean;

function sessao(id: string, org: string, numero: string, waba: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: org,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: numero,
    meta_waba_id: waba,
    archived_at: null,
    ...extra,
  };
}

/** Banco falso: aplica os `eq`/`is`/`limit` que a consulta real pede. */
function adminFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let limite = Infinity;
      const leitura = {
        select: () => leitura,
        eq: (c: string, v: unknown) => ((filtros[c] = v), leitura),
        is: (c: string, v: unknown) => ((filtros[c] = v), leitura),
        limit: (n: number) => ((limite = n), leitura),
        then(resolve: (r: unknown) => void) {
          if (falharConsulta) return resolve({ data: null, error: { code: "57P01", message: "conexão caiu" } });
          const linhas = (tabela === "channel_sessions" ? sessoes : []).filter((l) =>
            Object.entries(filtros).every(([c, v]) => l[c] === v),
          );
          resolve({ data: linhas.slice(0, limite), error: null });
        },
        update(patch: Linha) {
          const escrita: Escrita = { tabela, patch, filtros: {} };
          escritas.push(escrita);
          const u = {
            eq: (c: string, v: unknown) => ((escrita.filtros[c] = v), u),
            then: (resolve: (r: unknown) => void) => resolve({ error: null }),
          };
          return u;
        },
      };
      return leitura;
    },
  };
}

function assinar(corpo: string, segredo = SEGREDO): string {
  return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
}

function entrega(corpo: unknown, assinatura?: string | null): NextRequest {
  const texto = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const a = assinatura === undefined ? assinar(texto) : assinatura;
  if (a) headers["x-hub-signature-256"] = a;
  return new NextRequest("https://crm.exemplo.com/api/v1/webhooks/meta", { method: "POST", headers, body: texto });
}

function mensagem(waba: string, numero: string, wamid: string) {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5531900000000", phone_number_id: numero },
          contacts: [{ wa_id: "5531988887777", profile: { name: "Cliente" } }],
          messages: [{ id: wamid, from: "5531988887777", timestamp: "1790000000", type: "text", text: { body: "oi" } }],
        },
      },
    ],
  };
}

function status(waba: string, numero: string, wamid: string, s = "delivered") {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5531900000000", phone_number_id: numero },
          statuses: [{ id: wamid, status: s, recipient_id: "5531988887777" }],
        },
      },
    ],
  };
}

const corpo = (...entry: unknown[]) => ({ object: "whatsapp_business_account", entry });

beforeEach(() => {
  vi.clearAllMocks();
  sessoes = [sessao("s-a", ORG_A, NUM_A, WABA_A), sessao("s-b", ORG_B, NUM_B, WABA_B)];
  escritas = [];
  falharConsulta = false;
  vi.mocked(appDaMeta).mockResolvedValue({ appSecret: SEGREDO, verifyToken: VERIFY });
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as never);
  vi.mocked(ingestMetaInbound).mockResolvedValue({ status: "ingested", messageId: "m", conversationId: "c" });
});

describe("GET — handshake da Meta", () => {
  const handshake = (q: string) => GET(new NextRequest(`https://crm.exemplo.com/api/v1/webhooks/meta?${q}`));

  it("devolve o challenge em TEXTO PURO com o verify token da instalação", async () => {
    const res = await handshake(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("12345");
  });

  it.each([
    ["token errado", `hub.mode=subscribe&hub.verify_token=outro&hub.challenge=1`],
    ["modo errado", `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`],
    ["sem token", `hub.mode=subscribe&hub.challenge=1`],
  ])("recusa com 403: %s", async (_n, q) => {
    expect((await handshake(q)).status).toBe(403);
  });

  it("sem verify token configurado na instalação, recusa até o vazio", async () => {
    vi.mocked(appDaMeta).mockResolvedValue({ appSecret: SEGREDO, verifyToken: null });
    expect((await handshake(`hub.mode=subscribe&hub.verify_token=&hub.challenge=1`)).status).toBe(403);
  });
});

describe("POST — assinatura e contrato", () => {
  it("assinatura ausente, errada ou com outro segredo é 401 e nada é lido", async () => {
    const c = corpo(mensagem(WABA_A, NUM_A, "wamid.1"));
    for (const a of [null, "sha256=00", assinar(JSON.stringify(c), "outro-segredo")]) {
      expect((await POST(entrega(c, a))).status).toBe(401);
    }
    expect(ingestMetaInbound).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("sem App Secret configurado, toda entrega é 401", async () => {
    vi.mocked(appDaMeta).mockResolvedValue({ appSecret: null, verifyToken: VERIFY });
    expect((await POST(entrega(corpo(mensagem(WABA_A, NUM_A, "wamid.1"))))).status).toBe(401);
  });

  it("JSON inválido é 400 invalid_json", async () => {
    const res = await POST(entrega("{nao é json"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("invalid_json");
  });

  it("payload fora do contrato (entry não é lista) é 400 validation_failed", async () => {
    const res = await POST(entrega({ object: "whatsapp_business_account", entry: 3 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
  });
});

describe("POST — roteamento pelo phone_number_id", () => {
  it("número existente: ingere para a organização DONA do número", async () => {
    const res = await POST(entrega(corpo(mensagem(WABA_A, NUM_A, "wamid.1"))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ingested"] });
    expect(ingestMetaInbound).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMetaInbound).mock.calls[0]![2]).toEqual({ organizationId: ORG_A });
  });

  it("número inexistente: 200 com no_session, e ninguém recebe nada", async () => {
    const res = await POST(entrega(corpo(mensagem(WABA_A, "199999999999999", "wamid.x"), status(WABA_A, "199999999999999", "wamid.y"))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 2, outcomes: ["no_session", "no_session"] });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("número de canal ARQUIVADO não é entregue", async () => {
    sessoes = [sessao("s-a", ORG_A, NUM_A, WABA_A, { archived_at: "2026-09-01T00:00:00Z" })];
    const res = await POST(entrega(corpo(mensagem(WABA_A, NUM_A, "wamid.1"))));
    expect(await res.json()).toEqual({ received: 1, outcomes: ["no_session"] });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("número com dois donos ativos (banco sem o índice 0165) não é adivinhado", async () => {
    sessoes = [sessao("s-a", ORG_A, NUM_A, WABA_A), sessao("s-c", "org-c", NUM_A, WABA_A)];
    const res = await POST(entrega(corpo(mensagem(WABA_A, NUM_A, "wamid.1"))));
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ambiguous_session"] });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("WABA do evento diferente da WABA da sessão dona do número: ignorado", async () => {
    const res = await POST(entrega(corpo(mensagem("299999999999999", NUM_A, "wamid.1"))));
    expect(await res.json()).toEqual({ received: 1, outcomes: ["waba_divergente"] });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });
});

describe("POST — isolamento entre organizações", () => {
  it("uma entrega com números de duas organizações escreve em cada uma com o organization_id dela", async () => {
    const res = await POST(
      entrega(
        corpo(
          mensagem(WABA_A, NUM_A, "wamid.a1"),
          mensagem(WABA_B, NUM_B, "wamid.b1"),
          status(WABA_B, NUM_B, "wamid.b0", "failed"),
          status(WABA_A, NUM_A, "wamid.a0"),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 4, outcomes: ["ingested", "ingested"] });

    const orgsDaIngestao = vi.mocked(ingestMetaInbound).mock.calls.map((c) => [c[1].phoneNumberId, c[2].organizationId]);
    expect(orgsDaIngestao).toEqual([
      [NUM_A, ORG_A],
      [NUM_B, ORG_B],
    ]);
    expect(escritas).toEqual([
      { tabela: "messages", patch: expect.objectContaining({ status: "failed" }), filtros: { organization_id: ORG_B, external_id: "wamid.b0" } },
      { tabela: "messages", patch: expect.objectContaining({ status: "sent" }), filtros: { organization_id: ORG_A, external_id: "wamid.a0" } },
    ]);
  });

  it("o status de template (sem número) vai pela WABA, para cada organização que a tem — cada uma no seu escopo", async () => {
    sessoes = [...sessoes, sessao("s-c", "org-c", "100000000000003", WABA_A)];
    const res = await POST(
      entrega(
        corpo({
          id: WABA_A,
          changes: [
            {
              field: "message_template_status_update",
              value: { event: "APPROVED", message_template_name: "pedido", message_template_language: "pt_BR" },
            },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    const orgs = escritas.filter((e) => e.tabela === "meta_templates").map((e) => e.filtros.organization_id);
    expect(orgs.sort()).toEqual([ORG_A, "org-c"]);
    expect(escritas.every((e) => e.filtros.waba_id === WABA_A && e.filtros.name === "pedido")).toBe(true);
  });

  it("status de template de WABA sem sessão não escreve em ninguém", async () => {
    const res = await POST(
      entrega(
        corpo({
          id: "299999999999999",
          changes: [{ field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "x", message_template_language: "pt_BR" } }],
        }),
      ),
    );
    expect(await res.json()).toEqual({ received: 1, outcomes: ["no_session"] });
    expect(escritas).toHaveLength(0);
  });
});

describe("POST — falha do banco", () => {
  it("busca da sessão que falha é 500, para a Meta reentregar em vez de perder a mensagem", async () => {
    falharConsulta = true;
    const res = await POST(entrega(corpo(mensagem(WABA_A, NUM_A, "wamid.1"))));
    expect(res.status).toBe(500);
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });
});

describe("parser — o status de mensagem carrega o número", () => {
  it("expõe value.metadata.phone_number_id no evento de status", () => {
    const [e] = parseMetaWebhook(corpo(status(WABA_A, NUM_A, "wamid.1")) as never);
    expect(e).toMatchObject({ kind: "message_status", phoneNumberId: NUM_A, externalId: "wamid.1" });
  });

  it("sem metadata, o status continua sendo lido (só sem número)", () => {
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: WABA_A, changes: [{ field: "messages", value: { statuses: [{ id: "wamid.9", status: "read" }] } }] }],
    });
    expect(e).toMatchObject({ kind: "message_status", externalId: "wamid.9" });
    expect(e).not.toHaveProperty("phoneNumberId");
  });
});
