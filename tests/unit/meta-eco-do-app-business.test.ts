/**
 * `smb_message_echoes` — a mensagem que o dono mandou pelo app WhatsApp Business
 * num número em coexistência.
 *
 * O que cada bloco tranca:
 *   - o PARSER: o eco vira `echo_message` com o cliente em `to`; sem número que
 *     enviou, não vira nada; `messages`/`statuses` seguem como estavam;
 *   - a INGESTÃO: linha `outbound` + `external_device`, organização de quem chama,
 *     reentrega sem duplicar e sem pausar de novo, pausa da IA como no canal por
 *     QR (inclusive a exceção do eco de envio nosso em voo);
 *   - as DUAS ROTAS: o eco passa pelo HMAC, vai para a organização DONA do número
 *     (universal) ou do token (compatibilidade), e WABA divergente ou número sem
 *     dono não escreve em ninguém.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDaIngestao from "@/lib/channels/meta/ingest";
import type * as ModuloDoEco from "@/lib/channels/meta/ingest-eco";
import type * as ModuloDaSessao from "@/lib/channels/meta/session";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => true) }));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: vi.fn(async () => false),
  registrarMensagemIgnorada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn(async () => null) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { audit } from "@/lib/audit";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { ingestMetaEcho } from "@/lib/channels/meta/ingest-eco";
import { parseMetaWebhook, type EchoMessageEvent, type MetaWebhookEnvelope } from "@/lib/channels/meta/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { ehNumeroInternoDeAviso } from "@/lib/escalacao/numero-interno-de-aviso";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NUM_A = "100000000000001";
const NUM_B = "100000000000002";
const WABA_A = "200000000000001";
const WABA_B = "200000000000002";
const CLIENTE = "5531988887777";

function eco(waba: string, numero: string | null, wamid: string, extra: Record<string, unknown> = {}) {
  return {
    id: waba,
    changes: [
      {
        field: "smb_message_echoes",
        value: {
          messaging_product: "whatsapp",
          ...(numero ? { metadata: { display_phone_number: "5531900000000", phone_number_id: numero } } : {}),
          message_echoes: [
            {
              from: "5531900000000",
              to: CLIENTE,
              id: wamid,
              timestamp: "1790000000",
              type: "text",
              text: { body: "respondi pelo celular" },
              ...extra,
            },
          ],
        },
      },
    ],
  };
}

const corpo = (...entry: unknown[]): MetaWebhookEnvelope =>
  ({ object: "whatsapp_business_account", entry }) as MetaWebhookEnvelope;

// ─── Parser ─────────────────────────────────────────────────────────────────

describe("parseMetaWebhook — smb_message_echoes", () => {
  it("vira echo_message com o CLIENTE em `to` e o número que enviou", () => {
    expect(parseMetaWebhook(corpo(eco(WABA_A, NUM_A, "wamid.E1")))).toEqual([
      {
        kind: "echo_message",
        wabaId: WABA_A,
        phoneNumberId: NUM_A,
        externalId: "wamid.E1",
        to: CLIENTE,
        sentAt: new Date(1790000000 * 1000),
        type: "text",
        text: "respondi pelo celular",
        media: null,
        // O item bruto vai junto: é o que a quarentena guarda (0496).
        bruto: expect.objectContaining({ id: "wamid.E1", to: CLIENTE }),
      },
    ]);
  });

  it("mídia vem com o id da Meta, como na recebida", () => {
    const [e] = parseMetaWebhook(
      corpo(eco(WABA_A, NUM_A, "wamid.E2", { type: "image", text: undefined, image: { id: "media-1", mime_type: "image/jpeg" } })),
    );
    expect(e).toMatchObject({ kind: "echo_message", type: "image", media: { id: "media-1", mime: "image/jpeg", voice: false } });
  });

  it("sem o número que enviou (metadata.phone_number_id), o eco não tem dono e fica de fora", () => {
    expect(parseMetaWebhook(corpo(eco(WABA_A, null, "wamid.E3")))).toEqual([]);
  });

  it("eco sem id ou sem destinatário não vira evento", () => {
    expect(parseMetaWebhook(corpo(eco(WABA_A, NUM_A, "wamid.E4", { to: undefined })))).toEqual([]);
    expect(parseMetaWebhook(corpo(eco(WABA_A, NUM_A, "", {})))).toEqual([]);
  });

  it("history e smb_app_state_sync nunca viram mensagem nem eco — só payload de sincronização (0495)", () => {
    const outros = ["history", "smb_app_state_sync"].map((field) => ({
      id: WABA_A,
      changes: [{ field, value: { metadata: { phone_number_id: NUM_A }, history: [], state_sync: [] } }],
    }));
    expect(parseMetaWebhook(corpo(...outros)).map((e) => e.kind)).toEqual(["sync_payload", "sync_payload"]);
  });
});

// ─── Ingestão ───────────────────────────────────────────────────────────────

const EVENTO: EchoMessageEvent = {
  kind: "echo_message",
  wabaId: WABA_A,
  phoneNumberId: NUM_A,
  externalId: "wamid.ECO",
  to: CLIENTE,
  sentAt: new Date("2026-09-26T12:00:00.000Z"),
  type: "text",
  text: "respondi pelo celular",
  media: null,
};

interface Estado {
  sessoes: Array<{ id: string; organization_id: string; meta_phone_number_id: string }>;
  mensagens: Array<Record<string, unknown>>;
  emVoo: Array<{ body: string | null; type: string | null }>;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
  consultasDeSessao: Array<Record<string, unknown>>;
}

/** Banco falso: sessão por filtros, mensagens com unique (org, external_id), RPCs fixas. */
function bancoFalso(estado: Estado): SupabaseClient {
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => ((filtros[c] = v), q),
      is: (c: string, v: unknown) => ((filtros[c] = v), q),
      in: () => q,
      gte: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (tabela !== "channel_sessions") return { data: null, error: null };
        estado.consultasDeSessao.push({ ...filtros });
        const linha = estado.sessoes.find(
          (s) => s.organization_id === filtros.organization_id && s.meta_phone_number_id === filtros.meta_phone_number_id,
        );
        return { data: linha ? { id: linha.id, organization_id: linha.organization_id } : null, error: null };
      },
      // Leitura em lista: só a checagem de envio nosso em voo usa.
      then: (resolve: (r: unknown) => void) => resolve({ data: estado.emVoo, error: null }),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          maybeSingle: async () => {
            const repetida = estado.mensagens.some(
              (m) => m.organization_id === linha.organization_id && m.external_id === linha.external_id,
            );
            if (repetida) return { data: null, error: { code: "23505", message: "duplicate key" } };
            estado.mensagens.push(linha);
            return { data: { id: `msg-${estado.mensagens.length}` }, error: null };
          },
        }),
      }),
    };
    return q;
  };
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ nome, args });
    if (nome === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
    if (nome === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

/** O banco falso, com a leitura de `channel_sessions.meta_onboarding_em` errando. */
function bancoComOnboardingIlegivel(estado: Estado): SupabaseClient {
  const banco = bancoFalso(estado);
  const from = banco.from.bind(banco);
  (banco as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = from(t) as unknown as Record<string, unknown>;
    if (t === "channel_sessions") {
      const select = q.select as (c?: string) => unknown;
      q.select = (c?: string) => {
        if (c === "meta_onboarding_em") q.maybeSingle = async () => ({ data: null, error: { code: "57P01", message: "conexão caiu" } });
        return select(c);
      };
    }
    return q;
  };
  return banco;
}

function estadoNovo(): Estado {
  return {
    sessoes: [
      { id: "s-a", organization_id: ORG_A, meta_phone_number_id: NUM_A },
      { id: "s-b", organization_id: ORG_B, meta_phone_number_id: NUM_B },
    ],
    mensagens: [],
    emVoo: [],
    rpcs: [],
    consultasDeSessao: [],
  };
}

describe("ingestMetaEcho", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grava OUTBOUND + external_device na organização de quem chama, com o cliente como contato", async () => {
    const estado = estadoNovo();
    const r = await ingestMetaEcho(bancoFalso(estado), EVENTO, { organizationId: ORG_A });

    expect(r).toEqual({ status: "ingested", messageId: "msg-1", conversationId: "conversa-1" });
    expect(estado.consultasDeSessao[0]).toMatchObject({ organization_id: ORG_A, meta_phone_number_id: NUM_A });
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0]).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: "s-a",
      contact_id: "contato-1",
      conversation_id: "conversa-1",
      direction: "outbound",
      sent_via: "external_device",
      status: "sent",
      type: "text",
      body: "respondi pelo celular",
      external_id: "wamid.ECO",
    });
    const contato = estado.rpcs.find((c) => c.nome === "fn_upsert_wa_contact")!.args;
    expect(contato).toMatchObject({ p_org: ORG_A, p_chat_id: CLIENTE, p_notify: null });
    expect(marcarConversaComMensagem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG_A, conversationId: "conversa-1", direction: "outbound" }),
    );
  });

  it("pausa a IA na conversa — uma pessoa respondeu por fora do CRM", async () => {
    await ingestMetaEcho(bancoFalso(estadoNovo()), EVENTO, { organizationId: ORG_A });
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalledTimes(1);
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_A,
      conversationId: "conversa-1",
      canal: "meta",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "message.sent", organizationId: ORG_A, metadata: expect.objectContaining({ from_user_phone: true }) }),
    );
  });

  it("REENTREGA não duplica, não pausa de novo e não audita de novo", async () => {
    const estado = estadoNovo();
    const admin = bancoFalso(estado);
    await ingestMetaEcho(admin, EVENTO, { organizationId: ORG_A });
    const segunda = await ingestMetaEcho(admin, EVENTO, { organizationId: ORG_A });

    expect(segunda).toEqual({ status: "duplicate" });
    expect(estado.mensagens).toHaveLength(1);
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("eco de um envio NOSSO ainda em voo (mesmo corpo) grava a linha mas não cala a IA — como no canal por QR", async () => {
    const estado = estadoNovo();
    estado.emVoo = [{ body: "respondi pelo celular", type: "text" }];
    const r = await ingestMetaEcho(bancoFalso(estado), EVENTO, { organizationId: ORG_A });
    expect(r.status).toBe("ingested");
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("número que a organização NÃO administra é no_session — e nada é gravado", async () => {
    const estado = estadoNovo();
    // O número é da organização B; quem chama diz organização A.
    const r = await ingestMetaEcho(bancoFalso(estado), { ...EVENTO, phoneNumberId: NUM_B }, { organizationId: ORG_A });
    expect(r).toEqual({ status: "no_session" });
    expect(estado.mensagens).toHaveLength(0);
    expect(estado.rpcs).toHaveLength(0);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("o número interno de avisos não vira atendimento", async () => {
    vi.mocked(ehNumeroInternoDeAviso).mockResolvedValueOnce(true);
    const estado = estadoNovo();
    const r = await ingestMetaEcho(bancoFalso(estado), EVENTO, { organizationId: ORG_A });
    expect(r).toEqual({ status: "ignored", reason: "numero_interno_de_aviso" });
    expect(estado.mensagens).toHaveLength(0);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });
});

// ─── As duas rotas ─────────────────────────────────────────────────────────

const SEGREDO = "app-secret-da-instalacao-de-teste";
const ecosIngeridos: Array<{ evento: EchoMessageEvent; org: string }> = [];
const inboundIngeridos: unknown[] = [];
let sessoesDaRota: Array<Record<string, unknown>> = [];
let sessaoDoToken: { id: string; organizationId: string; wabaId: string | null } | null = null;
/**
 * A1: quando ligado, a rota chama o `ingestMetaEcho` REAL com um banco cuja leitura
 * do onboarding do canal erra — é o caminho inteiro, da rota à porta de suspeita.
 */
let onboardingIlegivel: Estado | null = null;

vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn(async () => ({ appSecret: SEGREDO, verifyToken: "v" })) }));
vi.mock("@/lib/channels/meta/ingest-eco", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoEco>();
  return {
    ...real,
    ingestMetaEcho: vi.fn(async (admin: SupabaseClient, e: EchoMessageEvent, dono: { organizationId: string }) => {
      if (onboardingIlegivel) return real.ingestMetaEcho(bancoComOnboardingIlegivel(onboardingIlegivel), e, dono);
      // Nas rotas, só o ROTEAMENTO interessa; a ingestão real está medida acima.
      if ((admin as unknown as { rota?: boolean }).rota) {
        ecosIngeridos.push({ evento: e, org: dono.organizationId });
        return { status: "ingested", messageId: "m", conversationId: "c" };
      }
      return real.ingestMetaEcho(admin, e, dono);
    }),
  };
});
vi.mock("@/lib/channels/meta/ingest", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaIngestao>();
  return {
    ...real,
    ingestMetaInbound: vi.fn(async (_a: unknown, e: unknown) => {
      inboundIngeridos.push(e);
      return { status: "ingested", messageId: "m", conversationId: "c" };
    }),
  };
});
vi.mock("@/lib/channels/meta/session", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaSessao>();
  return { ...real, metaSessionByWebhookToken: vi.fn(async () => sessaoDoToken) };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const from = (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filtros[c] = v), q),
        is: (c: string, v: unknown) => ((filtros[c] = v), q),
        limit: () => q,
        then: (resolve: (r: unknown) => void) =>
          resolve({
            data: (tabela === "channel_sessions" ? sessoesDaRota : []).filter((l) =>
              Object.entries(filtros).every(([c, v]) => l[c] === v),
            ),
            error: null,
          }),
        update: () => {
          const u: Record<string, unknown> = { eq: () => u, then: (r: (x: unknown) => void) => r({ error: null }) };
          return u;
        },
      };
      return q;
    };
    return { rota: true, from };
  },
}));

function assinar(texto: string): string {
  return `sha256=${createHmac("sha256", SEGREDO).update(texto, "utf8").digest("hex")}`;
}

function entrega(url: string, c: unknown, assinatura?: string): NextRequest {
  const texto = JSON.stringify(c);
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura ?? assinar(texto) },
    body: texto,
  });
}

describe("rotas de webhook — o eco chega à organização certa", () => {
  beforeEach(() => {
    ecosIngeridos.length = 0;
    inboundIngeridos.length = 0;
    sessoesDaRota = [
      { id: "s-a", organization_id: ORG_A, provider: "meta_cloud", meta_phone_number_id: NUM_A, meta_waba_id: WABA_A, archived_at: null },
      { id: "s-b", organization_id: ORG_B, provider: "meta_cloud", meta_phone_number_id: NUM_B, meta_waba_id: WABA_B, archived_at: null },
    ];
    sessaoDoToken = { id: "s-a", organizationId: ORG_A, wabaId: WABA_A };
    onboardingIlegivel = null;
  });

  describe("A1 — onboarding do canal ilegível: a entrega falha e a Meta reentrega", () => {
    it("universal: 500, sem mensagem, contato, conversa, pausa, auditoria nem evento", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      onboardingIlegivel = estadoNovo();
      const res = await POST(entrega("https://crm.exemplo.com/api/v1/webhooks/meta", corpo(eco(WABA_A, NUM_A, "wamid.A1"))));
      expect(res.status).toBe(500);
      expect(onboardingIlegivel.mensagens).toHaveLength(0);
      expect(onboardingIlegivel.rpcs).toHaveLength(0);
      expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
      expect(marcarConversaComMensagem).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("token: a exceção sobe da rota (o framework responde 5xx), sem efeito nenhum", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
      onboardingIlegivel = estadoNovo();
      const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;
      await expect(
        POST(entrega("https://crm.exemplo.com/api/v1/webhooks/meta/token-de-teste", corpo(eco(WABA_A, NUM_A, "wamid.A1T"))), ctx),
      ).rejects.toThrow("channel_sessions (onboarding)");
      expect(onboardingIlegivel.mensagens).toHaveLength(0);
      expect(onboardingIlegivel.rpcs).toHaveLength(0);
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe("universal (/api/v1/webhooks/meta)", () => {
    const URL_UNIVERSAL = "https://crm.exemplo.com/api/v1/webhooks/meta";

    it("assinatura errada é 401 e nada é ingerido", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const res = await POST(entrega(URL_UNIVERSAL, corpo(eco(WABA_A, NUM_A, "wamid.X")), "sha256=00"));
      expect(res.status).toBe(401);
      expect(ecosIngeridos).toHaveLength(0);
    });

    it("cada eco vai para a organização DONA do número — nunca do corpo", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const res = await POST(entrega(URL_UNIVERSAL, corpo(eco(WABA_A, NUM_A, "wamid.A"), eco(WABA_B, NUM_B, "wamid.B"))));
      const body = (await res.json()) as { outcomes: string[] };
      expect(res.status).toBe(200);
      expect(ecosIngeridos.map((x) => [x.evento.externalId, x.org])).toEqual([
        ["wamid.A", ORG_A],
        ["wamid.B", ORG_B],
      ]);
      expect(body.outcomes).toEqual(["ingested", "ingested"]);
    });

    it("número sem sessão ativa: 200 sem ingerir", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const res = await POST(entrega(URL_UNIVERSAL, corpo(eco(WABA_A, "100000000000009", "wamid.N"))));
      expect(res.status).toBe(200);
      expect(ecosIngeridos).toHaveLength(0);
      expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["no_session"]);
    });

    it("eco sem número identificável não chega a procurar sessão", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const res = await POST(entrega(URL_UNIVERSAL, corpo(eco(WABA_A, null, "wamid.S"))));
      expect(res.status).toBe(200);
      expect(ecosIngeridos).toHaveLength(0);
    });

    it("WABA divergente da sessão dona do número não escreve", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const res = await POST(entrega(URL_UNIVERSAL, corpo(eco(WABA_B, NUM_A, "wamid.D"))));
      expect(res.status).toBe(200);
      expect(ecosIngeridos).toHaveLength(0);
      expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["waba_divergente"]);
    });

    it("regressão: mensagem recebida na mesma entrega segue pela ingestão de sempre", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/route");
      const recebida = {
        id: WABA_A,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: NUM_A },
              messages: [{ id: "wamid.IN", from: CLIENTE, timestamp: "1790000000", type: "text", text: { body: "oi" } }],
            },
          },
        ],
      };
      await POST(entrega(URL_UNIVERSAL, corpo(recebida, eco(WABA_A, NUM_A, "wamid.ECO2"))));
      expect(inboundIngeridos).toHaveLength(1);
      expect(ecosIngeridos.map((x) => x.evento.externalId)).toEqual(["wamid.ECO2"]);
    });
  });

  describe("compatibilidade (/api/v1/webhooks/meta/[token])", () => {
    const URL_TOKEN = "https://crm.exemplo.com/api/v1/webhooks/meta/token-de-teste";
    const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

    it("o eco vai para a organização do TOKEN", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
      const res = await POST(entrega(URL_TOKEN, corpo(eco(WABA_A, NUM_A, "wamid.T"))), ctx);
      expect(res.status).toBe(200);
      expect(ecosIngeridos.map((x) => [x.evento.externalId, x.org])).toEqual([["wamid.T", ORG_A]]);
    });

    it("WABA divergente da sessão do token é ignorada", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
      const res = await POST(entrega(URL_TOKEN, corpo(eco(WABA_B, NUM_B, "wamid.TD"))), ctx);
      expect(res.status).toBe(200);
      expect(ecosIngeridos).toHaveLength(0);
    });

    it("assinatura errada é 401", async () => {
      const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
      const res = await POST(entrega(URL_TOKEN, corpo(eco(WABA_A, NUM_A, "wamid.T2")), "sha256=00"), ctx);
      expect(res.status).toBe(401);
      expect(ecosIngeridos).toHaveLength(0);
    });
  });
});
