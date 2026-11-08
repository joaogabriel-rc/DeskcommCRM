import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health — o veredito do banco segue o que o PostgREST responde.
 *
 * Contexto (08/11/2026, produção): o ping do banco é
 * `GET /rest/v1/organizations?select=id&limit=1` com a anon key. Antes da
 * migration 9253 a policy de `organizations` valia para `anon` e chamava um
 * helper sem EXECUTE para anon — cada ping virava 401 no gateway e um
 * `permission denied for function fn_user_org_ids` no log do Postgres. Com a
 * 9253, anon não tem policy aplicável e a resposta é `200 []`.
 *
 * Este arquivo prende o contrato da rota em volta disso:
 *   - `200 []` (o caminho depois da 9253) é banco ok;
 *   - banco fora — 503 do PostgREST, 5xx do gateway, rede, tempo esgotado —
 *     é `down` e a rota responde 503, que é o que `update.sh` e monitores leem;
 *   - o 401 de um clone que ainda não aplicou a 9253 continua "ok" (o
 *     PostgREST chegou ao banco), para a atualização não ser revertida pelo
 *     próprio health;
 *   - o ping usa a anon key, nunca a service role — a sonda é pública e não
 *     pode ignorar RLS.
 */

const URL_DO_PROJETO = "https://projeto-do-cliente.supabase.co";
const ANON = "chave-anon-de-teste";
const SERVICE = "chave-service-role-de-teste";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "chave-anon-de-teste",
    SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste",
    UPSTASH_REDIS_REST_URL: "https://redis-de-teste.exemplo",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));

type Resposta = () => Promise<Response>;

/**
 * A fila responde ok; o serviço de mensagens fica sem endereço (degraded, que
 * a rota responde com 200). Só o banco varia, conforme o caso.
 */
function stubFetch(banco: Resposta, chamadas: Parameters<typeof fetch>[] = []) {
  vi.stubGlobal("fetch", (entrada: string | URL | Request, init?: RequestInit) => {
    chamadas.push([entrada, init]);
    const alvo = typeof entrada === "string" ? entrada : String(entrada);
    if (alvo.startsWith(URL_DO_PROJETO)) return banco();
    return Promise.resolve(new Response('{"result":"PONG"}', { status: 200 }));
  });
}

const json = (corpo: unknown, status: number) =>
  Promise.resolve(new Response(JSON.stringify(corpo), { status }));

async function saude() {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"));
  return { http: res.status, data: (await res.json()).data };
}

describe("GET /api/v1/health — banco disponível", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("200 [] (anon sem policy aplicável, depois da 9253) é banco ok e a rota responde 200", async () => {
    stubFetch(() => json([], 200));
    const { http, data } = await saude();
    expect(data.checks.supabase.status).toBe("ok");
    expect(data.status).toBe("degraded");
    expect(http).toBe(200);
  });

  it("o ping usa a anon key — nunca a service role — e pede só id com limit 1", async () => {
    const chamadas: Parameters<typeof fetch>[] = [];
    stubFetch(() => json([], 200), chamadas);
    await saude();

    const ping = chamadas.find(([e]) => String(e).startsWith(URL_DO_PROJETO));
    expect(ping).toBeDefined();
    expect(String(ping?.[0])).toBe(`${URL_DO_PROJETO}/rest/v1/organizations?select=id&limit=1`);
    const headers = new Headers(ping?.[1]?.headers);
    expect(headers.get("apikey")).toBe(ANON);
    expect(headers.get("Authorization")).toBe(`Bearer ${ANON}`);
    expect(JSON.stringify([...headers])).not.toContain(SERVICE);
  });

  it("clone que ainda não aplicou a 9253 (401 com 42501) segue ok — o PostgREST chegou ao banco", async () => {
    stubFetch(() =>
      json({ code: "42501", message: "permission denied for function fn_user_org_ids" }, 401),
    );
    const { http, data } = await saude();
    expect(data.checks.supabase.status).toBe("ok");
    expect(http).toBe(200);
  });
});

describe("GET /api/v1/health — banco indisponível responde 503", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    [
      "PostgREST sem schema cache (banco fora)",
      503,
      { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." },
    ],
    [
      "PostgREST sem conexão com o banco",
      503,
      { code: "PGRST000", message: "Could not connect with the database" },
    ],
    [
      "gateway com o upstream fora",
      502,
      { message: "An invalid response was received from the upstream server" },
    ],
    ["timeout do gateway", 504, { message: "upstream request timeout" }],
    ["erro interno do PostgREST", 500, { code: "XX000", message: "internal" }],
  ])("%s (%i) → supabase down, status unhealthy, HTTP 503", async (_caso, status, corpo) => {
    stubFetch(() => json(corpo, status));
    const { http, data } = await saude();
    expect(data.checks.supabase.status).toBe("down");
    expect(data.checks.supabase.error).toBe("erro_ao_consultar");
    expect(data.status).toBe("unhealthy");
    expect(http).toBe(503);
  });

  it("falha de rede (fetch failed) → down e 503", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const { http, data } = await saude();
    expect(data.checks.supabase.status).toBe("down");
    expect(data.checks.supabase.reason).toBeTruthy();
    expect(http).toBe(503);
  });

  it("banco que não responde em 3 s → down por tempo esgotado e 503", async () => {
    vi.useFakeTimers();
    stubFetch(() => new Promise<Response>(() => {}));
    const pendente = saude();
    await vi.advanceTimersByTimeAsync(3_100);
    const { http, data } = await pendente;
    expect(data.checks.supabase.status).toBe("down");
    expect(http).toBe(503);
  });
});
