/**
 * O lado do servidor do Cadastro Incorporado da Meta, com a Graph API dublada no
 * `fetch`: troca do code, inspeção do token e descoberta de WABA e número.
 *
 * O caso de segurança que este arquivo tranca: a WABA e o número que o NAVEGADOR
 * sugere só valem se a Meta os confirmar — sugestão forjada é recusada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { META_APP_ID: "1111122222", META_EMBEDDED_SIGNUP_CONFIG_ID: "3333344444" },
}));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn() }));

import { appDaMeta } from "@/lib/channels/meta/app";
import {
  appDoCadastro,
  descobrirCanal,
  disponibilidadeDoCadastroIncorporado,
  inspecionarToken,
  trocarCodigoPorToken,
} from "@/lib/channels/meta/cadastro-incorporado";
import { env } from "@/lib/env";

const APP = { appId: "1111122222", appSecret: "segredo-do-app-de-teste" };
const CODE = "AQCcodeDeTesteQueNaoPodeVazar_123";
const TOKEN = "EAAGtokenDeTesteQueNaoPodeVazar";
const WABA = "200000000000001";
const OUTRA_WABA = "200000000000002";
const NUMERO = "100000000000001";

interface Chamada {
  url: URL;
  authorization: string | null;
}

let chamadas: Chamada[];
let respostas: Array<{ status: number; corpo: unknown } | "rede">;

function responder(...fila: Array<{ status: number; corpo: unknown } | "rede">) {
  respostas = fila;
}

beforeEach(() => {
  chamadas = [];
  respostas = [];
  vi.mocked(appDaMeta).mockResolvedValue({ appSecret: APP.appSecret, verifyToken: "vt" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: URL | string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      chamadas.push({ url: new URL(String(entrada)), authorization: headers.get("authorization") });
      const r = respostas.shift();
      if (!r || r === "rede") throw new Error(`falha de rede em ${String(entrada)}`);
      return new Response(JSON.stringify(r.corpo), { status: r.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function semSegredo(valor: unknown) {
  const texto = JSON.stringify(valor);
  for (const s of [CODE, TOKEN, APP.appSecret]) expect(texto).not.toContain(s);
}

describe("disponibilidade", () => {
  it("disponível com App ID, Config ID e App Secret", async () => {
    const d = await disponibilidadeDoCadastroIncorporado();
    expect(d.disponivel).toBe(true);
    expect(d.versaoDaGraph).toMatch(/^v\d+\.\d+$/);
    expect(await appDoCadastro()).toEqual(APP);
  });

  it("nomeia o que falta — e nunca devolve o segredo", async () => {
    vi.mocked(appDaMeta).mockResolvedValue({ appSecret: null, verifyToken: null });
    const d = await disponibilidadeDoCadastroIncorporado();
    expect(d).toMatchObject({ disponivel: false, faltando: ["META_APP_SECRET"] });
    expect(await appDoCadastro()).toBeNull();
  });

  it("App ID que não é só dígitos conta como ausente", async () => {
    const original = env.META_APP_ID;
    (env as { META_APP_ID: string }).META_APP_ID = "<preencha>";
    try {
      const d = await disponibilidadeDoCadastroIncorporado();
      expect(d).toMatchObject({ disponivel: false, faltando: ["META_APP_ID"] });
      expect(await appDoCadastro()).toBeNull();
    } finally {
      (env as { META_APP_ID: string }).META_APP_ID = original;
    }
  });
});

describe("troca do code", () => {
  it("é GET em /oauth/access_token com client_id, client_secret e code — sem redirect_uri", async () => {
    responder({ status: 200, corpo: { access_token: TOKEN, token_type: "bearer" } });
    const r = await trocarCodigoPorToken(CODE, APP);
    expect(r).toEqual({ ok: true, token: TOKEN });
    const [c] = chamadas;
    expect(c!.url.pathname).toMatch(/^\/v\d+\.\d+\/oauth\/access_token$/);
    expect(c!.url.searchParams.get("client_id")).toBe(APP.appId);
    expect(c!.url.searchParams.get("client_secret")).toBe(APP.appSecret);
    expect(c!.url.searchParams.get("code")).toBe(CODE);
    expect(c!.url.searchParams.has("redirect_uri")).toBe(false);
  });

  it.each([
    ["code expirado (subcódigo)", { error: { code: 100, error_subcode: 36007, message: "x" } }, "code_expirado"],
    ["code expirado (mensagem)", { error: { code: 100, message: "This authorization code has expired." } }, "code_expirado"],
    ["code já usado", { error: { code: 100, error_subcode: 36009, message: "x" } }, "code_usado"],
    ["code já usado (mensagem)", { error: { code: 100, message: "This authorization code has been used." } }, "code_usado"],
    ["app recusado", { error: { code: 1, message: "Error validating client secret." } }, "app_recusado"],
    ["code qualquer", { error: { code: 100, message: "Invalid verification code format." } }, "code_invalido"],
  ])("%s", async (_nome, corpo, motivo) => {
    responder({ status: 400, corpo });
    const r = await trocarCodigoPorToken(CODE, APP);
    expect(r).toMatchObject({ ok: false, motivo });
    semSegredo(r);
  });

  it("Meta fora do ar (5xx ou rede) é 'meta_indisponivel', e o erro de rede não carrega a URL", async () => {
    responder({ status: 503, corpo: {} });
    expect(await trocarCodigoPorToken(CODE, APP)).toMatchObject({ ok: false, motivo: "meta_indisponivel" });
    responder("rede");
    const r = await trocarCodigoPorToken(CODE, APP);
    expect(r).toMatchObject({ ok: false, motivo: "meta_indisponivel" });
    semSegredo(r);
  });

  it("200 sem access_token não é sucesso", async () => {
    responder({ status: 200, corpo: {} });
    expect(await trocarCodigoPorToken(CODE, APP)).toMatchObject({ ok: false });
  });
});

describe("inspeção do token (debug_token)", () => {
  const valido = (extra: Record<string, unknown> = {}) => ({
    status: 200,
    corpo: {
      data: {
        app_id: APP.appId,
        is_valid: true,
        expires_at: 0,
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA] },
          { scope: "whatsapp_business_messaging", target_ids: [WABA] },
        ],
        ...extra,
      },
    },
  });

  it("autentica com o app token no CABEÇALHO e lê as WABAs de gestão", async () => {
    responder(valido());
    const r = await inspecionarToken(TOKEN, APP);
    expect(r).toEqual({ ok: true, expiraEm: null, wabasAutorizadas: [WABA] });
    expect(chamadas[0]!.authorization).toBe(`Bearer ${APP.appId}|${APP.appSecret}`);
    expect(chamadas[0]!.url.searchParams.get("input_token")).toBe(TOKEN);
    expect(chamadas[0]!.url.searchParams.has("access_token")).toBe(false);
  });

  it("expires_at > 0 vira data ISO — o CRM não assume que o token é eterno", async () => {
    responder(valido({ expires_at: 1_800_000_000 }));
    const r = await inspecionarToken(TOKEN, APP);
    expect(r).toMatchObject({ ok: true, expiraEm: new Date(1_800_000_000 * 1000).toISOString() });
  });

  it("token inválido e token de OUTRO app são recusados", async () => {
    responder(valido({ is_valid: false }));
    expect(await inspecionarToken(TOKEN, APP)).toMatchObject({ ok: false, motivo: "token_invalido" });
    responder(valido({ app_id: "9999999999" }));
    expect(await inspecionarToken(TOKEN, APP)).toMatchObject({ ok: false, motivo: "token_de_outro_app" });
  });

  it("resposta de erro: 4xx é token inválido, 5xx é Meta indisponível", async () => {
    responder({ status: 400, corpo: { error: { code: 190 } } });
    expect(await inspecionarToken(TOKEN, APP)).toMatchObject({ ok: false, motivo: "token_invalido" });
    responder({ status: 500, corpo: {} });
    expect(await inspecionarToken(TOKEN, APP)).toMatchObject({ ok: false, motivo: "meta_indisponivel" });
  });
});

describe("descoberta de WABA e número", () => {
  const numeros = (...ids: string[]) => ({ status: 200, corpo: { data: ids.map((id) => ({ id })) } });

  it("usa a WABA sugerida quando ela está entre as autorizadas, e o número sugerido quando é dela", async () => {
    responder(numeros(NUMERO, "100000000000009"));
    const r = await descobrirCanal(TOKEN, [WABA, OUTRA_WABA], { wabaId: WABA, phoneNumberId: NUMERO });
    expect(r).toEqual({ ok: true, wabaId: WABA, phoneNumberId: NUMERO });
    expect(chamadas[0]!.url.pathname).toMatch(new RegExp(`/${WABA}/phone_numbers$`));
    expect(chamadas[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("RECUSA WABA sugerida que o token não autoriza — sem nem consultar os números", async () => {
    const r = await descobrirCanal(TOKEN, [WABA], { wabaId: "299999999999999", phoneNumberId: NUMERO });
    expect(r).toMatchObject({ ok: false, motivo: "waba_nao_autorizada" });
    expect(chamadas).toHaveLength(0);
  });

  it("RECUSA número sugerido que não pertence à WABA", async () => {
    responder(numeros("100000000000009"));
    const r = await descobrirCanal(TOKEN, [WABA], { wabaId: WABA, phoneNumberId: NUMERO });
    expect(r).toMatchObject({ ok: false, motivo: "numero_nao_pertence" });
  });

  it("sem sugestão (mensagem perdida): WABA e número únicos são descobertos pela Meta", async () => {
    responder(numeros(NUMERO));
    expect(await descobrirCanal(TOKEN, [WABA], {})).toEqual({ ok: true, wabaId: WABA, phoneNumberId: NUMERO });
  });

  it("sem sugestão e ambíguo, recusa em vez de escolher", async () => {
    expect(await descobrirCanal(TOKEN, [WABA, OUTRA_WABA], {})).toMatchObject({
      ok: false,
      motivo: "waba_ambigua",
    });
    responder(numeros(NUMERO, "100000000000009"));
    expect(await descobrirCanal(TOKEN, [WABA], {})).toMatchObject({ ok: false, motivo: "numero_ambiguo" });
  });

  it("nenhuma WABA autorizada, ou WABA sem número", async () => {
    expect(await descobrirCanal(TOKEN, [], {})).toMatchObject({ ok: false, motivo: "waba_nao_encontrada" });
    responder(numeros());
    expect(await descobrirCanal(TOKEN, [WABA], { wabaId: WABA })).toMatchObject({
      ok: false,
      motivo: "numero_nao_encontrado",
    });
  });

  it("falha da Meta ao listar números: 5xx é indisponível, 4xx é WABA não encontrada", async () => {
    responder({ status: 502, corpo: {} });
    expect(await descobrirCanal(TOKEN, [WABA], {})).toMatchObject({ ok: false, motivo: "meta_indisponivel" });
    responder({ status: 403, corpo: { error: { code: 200 } } });
    const r = await descobrirCanal(TOKEN, [WABA], {});
    expect(r).toMatchObject({ ok: false, motivo: "waba_nao_encontrada" });
    semSegredo(r);
  });
});
