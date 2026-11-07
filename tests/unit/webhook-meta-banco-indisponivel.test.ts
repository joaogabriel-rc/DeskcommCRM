/**
 * WEBHOOK DA META COM O BANCO FORA: 503, e não "token desconhecido".
 *
 * ─── O que aconteceu em produção (06/11/2026) ────────────────────────────────
 * O Supabase ficou quatro horas respondendo `fetch failed` e páginas 522 da
 * Cloudflare. `metaSessionByWebhookToken` lia só o `data` da consulta — o `error`
 * era descartado —, e com `data` vazio devolvia `null`. A rota traduzia `null`
 * em 404 "token desconhecido": foram 2.529 entregas recusadas, todas para os
 * DOIS tokens das sessões ativas. As mensagens chegaram de 6 a 10 horas depois,
 * pela reentrega da Meta.
 *
 * ─── O contrato que este arquivo tranca ──────────────────────────────────────
 *   - token que não existe ............................. 404 (como antes)
 *   - banco não respondeu (rede, 522, promessa rejeitada) 503 + Retry-After
 *   - banco respondeu com erro de consulta ............. 503 + Retry-After
 *   - sessão achada .................................... segue o processamento
 * E o mesmo no webhook universal, onde a busca é pelo número ou pela WABA —
 * com uma separação a mais: erro de PROCESSAMENTO continua 500, e não se
 * disfarça de falha de busca.
 *
 * Roda a `session.ts` REAL. Dublê só no banco, no App da Meta da instalação e
 * na ingestão (que tem os próprios testes).
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "app-secret-de-teste-do-banco-fora";
const VERIFY = "verify-token-de-teste-do-banco-fora";

vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn() }));
vi.mock("@/lib/channels/meta/ingest", () => ({ ingestMetaInbound: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { GET as GET_TOKEN, POST as POST_TOKEN } from "@/app/api/v1/webhooks/meta/[token]/route";
import { POST as POST_UNIVERSAL } from "@/app/api/v1/webhooks/meta/route";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta } from "@/lib/channels/meta/app";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import {
  FalhaAoBuscarSessaoDaMeta,
  metaSessionByPhoneNumberId,
  metaSessionByWebhookToken,
  metaSessionsByWabaId,
} from "@/lib/channels/meta/session";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TOKEN_A = "token-do-webhook-da-org-a";
const TOKEN_B = "token-do-webhook-da-org-b";
const NUM_A = "100000000000001";
const NUM_B = "100000000000002";
const WABA_A = "200000000000001";
const WABA_B = "200000000000002";

type Linha = Record<string, unknown>;

/** Como o banco se comporta na próxima consulta. */
type ModoDoBanco = "ok" | "fetch_failed" | "erro_de_consulta" | "rejeita" | "cloudflare_522";

const PAGINA_522 =
  '<!DOCTYPE html>\n<html>\n  <head><title>projeto.supabase.co | 522: Connection timed out</title></head>\n' +
  '  <body><span class="code-label">Error code 522</span>' +
  "x".repeat(4000) +
  "</body>\n</html>";

let sessoes: Linha[];
let modo: ModoDoBanco;
let consultas: Array<Record<string, unknown>>;

function sessao(id: string, org: string, token: string, numero: string, waba: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: org,
    provider: CHANNEL_PROVIDER_META,
    webhook_path_token: token,
    meta_phone_number_id: numero,
    meta_waba_id: waba,
    archived_at: null,
    ...extra,
  };
}

/** O desfecho de uma leitura, conforme o modo. `null` = o banco respondeu bem. */
function falhaDoModo(): { error: { code: string; message: string } } | "rejeita" | null {
  switch (modo) {
    case "fetch_failed":
      // É o que o supabase-js devolve quando o `fetch` não completa: não lança.
      return { error: { code: "", message: "TypeError: fetch failed" } };
    case "erro_de_consulta":
      return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
    case "cloudflare_522":
      return { error: { code: "", message: PAGINA_522 } };
    case "rejeita":
      return "rejeita";
    default:
      return null;
  }
}

/** Banco falso: aplica os `eq`/`is`/`limit` que a consulta real pede. */
function adminFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let limite = Infinity;
      const linhas = () =>
        (tabela === "channel_sessions" ? sessoes : [])
          .filter((l) => Object.entries(filtros).every(([c, v]) => l[c] === v))
          .slice(0, limite);
      const responder = (unica: boolean) => {
        consultas.push({ tabela, ...filtros });
        const falha = falhaDoModo();
        if (falha === "rejeita") return Promise.reject(new Error("socket hang up"));
        if (falha) return Promise.resolve({ data: null, ...falha });
        const ls = linhas();
        return Promise.resolve({ data: unica ? (ls[0] ?? null) : ls, error: null });
      };
      const leitura = {
        select: () => leitura,
        eq: (c: string, v: unknown) => ((filtros[c] = v), leitura),
        is: (c: string, v: unknown) => ((filtros[c] = v), leitura),
        limit: (n: number) => ((limite = n), leitura),
        maybeSingle: () => responder(true),
        then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return responder(false).then(resolve, reject);
        },
        update: () => {
          const u = { eq: () => u, then: (resolve: (r: unknown) => unknown) => resolve({ error: null }) };
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

function mensagem(waba: string, numero: string, wamid: string) {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          contacts: [{ wa_id: "5562988887777", profile: { name: "Cliente" } }],
          messages: [{ id: wamid, from: "5562988887777", timestamp: "1790000000", type: "text", text: { body: "oi" } }],
        },
      },
    ],
  };
}

function statusDeModelo(waba: string) {
  return {
    id: waba,
    changes: [
      {
        field: "message_template_status_update",
        value: { event: "APPROVED", message_template_name: "pedido", message_template_language: "pt_BR" },
      },
    ],
  };
}

const corpo = (...entry: unknown[]) => ({ object: "whatsapp_business_account", entry });

function entrega(url: string, c: unknown, assinatura?: string | null): NextRequest {
  const texto = JSON.stringify(c);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const a = assinatura === undefined ? assinar(texto) : assinatura;
  if (a) headers["x-hub-signature-256"] = a;
  return new NextRequest(url, { method: "POST", headers, body: texto });
}

const urlDoToken = (t: string) => `https://crm.exemplo.com/api/v1/webhooks/meta/${t}`;
const ctxDoToken = (t: string) => ({ params: Promise.resolve({ token: t }) }) as never;
const postNoToken = (t: string, c: unknown, assinatura?: string | null) =>
  POST_TOKEN(entrega(urlDoToken(t), c, assinatura), ctxDoToken(t));
const postUniversal = (c: unknown) => POST_UNIVERSAL(entrega("https://crm.exemplo.com/api/v1/webhooks/meta", c));
const handshake = (t: string) =>
  GET_TOKEN(
    new NextRequest(`${urlDoToken(t)}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`),
    ctxDoToken(t),
  );

async function erroDoCorpo(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const FALHAS: ReadonlyArray<[string, ModoDoBanco]> = [
  ["conexão (fetch failed)", "fetch_failed"],
  ["erro de consulta (statement timeout)", "erro_de_consulta"],
  ["página 522 da Cloudflare", "cloudflare_522"],
  ["promessa rejeitada", "rejeita"],
];

beforeEach(() => {
  vi.clearAllMocks();
  sessoes = [
    sessao("s-a", ORG_A, TOKEN_A, NUM_A, WABA_A),
    sessao("s-b", ORG_B, TOKEN_B, NUM_B, WABA_B),
  ];
  modo = "ok";
  consultas = [];
  vi.mocked(appDaMeta).mockResolvedValue({ appSecret: SEGREDO, verifyToken: VERIFY });
  vi.mocked(createAdminClient).mockImplementation(() => adminFalso() as never);
  vi.mocked(ingestMetaInbound).mockResolvedValue({ status: "ingested", messageId: "m", conversationId: "c" });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("busca da sessão — 'não achei' e 'não consegui perguntar' são coisas diferentes", () => {
  it("token inexistente devolve null (e só isso)", async () => {
    expect(await metaSessionByWebhookToken("token-que-ninguem-tem")).toBeNull();
  });

  it("token de sessão ativa devolve a sessão daquela organização", async () => {
    expect(await metaSessionByWebhookToken(TOKEN_B)).toEqual({ id: "s-b", organizationId: ORG_B, wabaId: WABA_B });
  });

  it.each(FALHAS)("%s: a busca por token LANÇA FalhaAoBuscarSessaoDaMeta em vez de devolver null", async (_n, m) => {
    modo = m;
    await expect(metaSessionByWebhookToken(TOKEN_A)).rejects.toBeInstanceOf(FalhaAoBuscarSessaoDaMeta);
  });

  it.each(FALHAS)("%s: as buscas do universal (número e WABA) lançam a mesma classe", async (_n, m) => {
    modo = m;
    const admin = adminFalso() as never;
    await expect(metaSessionByPhoneNumberId(admin, NUM_A)).rejects.toBeInstanceOf(FalhaAoBuscarSessaoDaMeta);
    await expect(metaSessionsByWabaId(admin, WABA_A)).rejects.toBeInstanceOf(FalhaAoBuscarSessaoDaMeta);
  });

  it("a página inteira do 522 não vai parar no log: a mensagem do erro é cortada", async () => {
    modo = "cloudflare_522";
    const err = await metaSessionByWebhookToken(TOKEN_A).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalhaAoBuscarSessaoDaMeta);
    expect((err as Error).message.length).toBeLessThan(260);
    expect((err as Error).message).toMatch(/^sessao_do_token: /);
  });

  it("token curto demais não chega ao banco", async () => {
    modo = "fetch_failed";
    expect(await metaSessionByWebhookToken("curto")).toBeNull();
    expect(consultas).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("rota por token — POST", () => {
  it("token inexistente: 404 not_found, nada é ingerido", async () => {
    const res = await postNoToken("token-que-ninguem-tem", corpo(mensagem(WABA_A, NUM_A, "wamid.1")));
    expect(res.status).toBe(404);
    expect((await erroDoCorpo(res)).code).toBe("not_found");
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it.each(FALHAS)("%s: 503 com Retry-After — e NÃO é registrado como token desconhecido", async (_n, m) => {
    modo = m;
    const res = await postNoToken(TOKEN_A, corpo(mensagem(WABA_A, NUM_A, "wamid.1")));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(await erroDoCorpo(res)).toEqual({ code: "upstream_unavailable", message: "session_lookup_unavailable" });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
    expect(appDaMeta).not.toHaveBeenCalled();

    const avisos = vi.mocked(logger.warn).mock.calls.map(([msg]) => msg);
    expect(avisos).not.toContain("[meta.webhook] entrega recusada: token desconhecido");
    const erro = vi.mocked(logger.error).mock.calls.find(([msg]) => String(msg).includes("busca da sessão falhou"));
    expect(erro?.[1]).toMatchObject({ status: 503, rota: "token" });
    // O token nunca vai ao log — só o prefixo do hash.
    expect(JSON.stringify(erro)).not.toContain(TOKEN_A);
  });

  it("sessão válida: 200 e a mensagem é ingerida na organização do TOKEN", async () => {
    const res = await postNoToken(TOKEN_B, corpo(mensagem(WABA_B, NUM_B, "wamid.2")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ingested"] });
    expect(ingestMetaInbound).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMetaInbound).mock.calls[0]![2]).toEqual({ organizationId: ORG_B });
  });

  it("isolamento: token da org A com evento da WABA da org B não escreve em ninguém", async () => {
    const res = await postNoToken(TOKEN_A, corpo(mensagem(WABA_B, NUM_B, "wamid.3")));
    expect(res.status).toBe(200);
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("autenticação intacta: sessão achada com assinatura errada continua 401", async () => {
    const res = await postNoToken(TOKEN_A, corpo(mensagem(WABA_A, NUM_A, "wamid.4")), "sha256=00");
    expect(res.status).toBe(401);
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("canal arquivado continua sendo token desconhecido (404), não falha de banco", async () => {
    sessoes = [sessao("s-a", ORG_A, TOKEN_A, NUM_A, WABA_A, { archived_at: "2026-10-01T00:00:00Z" })];
    const res = await postNoToken(TOKEN_A, corpo(mensagem(WABA_A, NUM_A, "wamid.5")));
    expect(res.status).toBe(404);
  });
});

describe("rota por token — GET (handshake)", () => {
  it("token inexistente: 404", async () => {
    expect((await handshake("token-que-ninguem-tem")).status).toBe(404);
  });

  it.each(FALHAS)("%s: 503 com Retry-After", async (_n, m) => {
    modo = m;
    const res = await handshake(TOKEN_A);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("sessão válida: devolve o challenge em texto puro", async () => {
    const res = await handshake(TOKEN_A);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("webhook universal — o mesmo tratamento", () => {
  it.each(FALHAS)("%s na busca pelo NÚMERO: 503 com Retry-After, nada ingerido", async (_n, m) => {
    modo = m;
    const res = await postUniversal(corpo(mensagem(WABA_A, NUM_A, "wamid.10")));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await erroDoCorpo(res)).toEqual({ code: "upstream_unavailable", message: "session_lookup_unavailable" });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it.each(FALHAS)("%s na busca pela WABA (estado de modelo): 503", async (_n, m) => {
    modo = m;
    const res = await postUniversal(corpo(statusDeModelo(WABA_A)));
    expect(res.status).toBe(503);
  });

  it("número sem sessão: 200 no_session (a Meta não deve reentregar o que não é nosso)", async () => {
    const res = await postUniversal(corpo(mensagem(WABA_A, "100000000000999", "wamid.11")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["no_session"] });
  });

  it("sessão válida: 200, e cada número vai para a organização DONA dele", async () => {
    const res = await postUniversal(corpo(mensagem(WABA_A, NUM_A, "wamid.12"), mensagem(WABA_B, NUM_B, "wamid.13")));
    expect(res.status).toBe(200);
    const orgs = vi.mocked(ingestMetaInbound).mock.calls.map((c) => (c[2] as { organizationId: string }).organizationId);
    expect(orgs.sort()).toEqual([ORG_A, ORG_B]);
  });

  it("erro de PROCESSAMENTO continua 500 — não se disfarça de falha de busca", async () => {
    vi.mocked(ingestMetaInbound).mockRejectedValue(new Error("quebrou no meio"));
    const res = await postUniversal(corpo(mensagem(WABA_A, NUM_A, "wamid.14")));
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await erroDoCorpo(res)).toEqual({ code: "internal_error", message: "event_processing_failed" });
  });

  it("autenticação intacta: assinatura errada é 401 antes de qualquer busca", async () => {
    modo = "fetch_failed";
    const c = corpo(mensagem(WABA_A, NUM_A, "wamid.15"));
    const res = await POST_UNIVERSAL(entrega("https://crm.exemplo.com/api/v1/webhooks/meta", c, "sha256=00"));
    expect(res.status).toBe(401);
    expect(consultas).toHaveLength(0);
  });
});
