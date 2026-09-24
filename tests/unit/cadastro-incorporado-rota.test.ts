/**
 * POST /api/v1/channels/official/cadastro/concluir — a rota de verdade, com o
 * `state` de verdade; dublê só nas guardas, no banco, na Meta e na persistência.
 *
 * O que cada caso tranca:
 *   - a ORDEM: `state` antes de tudo, evento não suportado antes de gastar o code,
 *     queima do nonce ANTES da troca (replay nunca chega à Meta);
 *   - o vínculo: state de outra organização, de outra pessoa ou vencido é recusado;
 *   - a desconfiança: quem vai para a persistência é o que a META confirmou, não o
 *     que o navegador sugeriu;
 *   - o sigilo: code e token não aparecem na resposta nem no log;
 *   - o 502: falha da Meta depois da queima não pode ser 429/503, que o cliente reenvia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloDoCadastro from "@/lib/channels/meta/cadastro-incorporado";

const SEGREDO = "segredo-interno-de-teste-com-32-chars";
const BASE = "https://crm.exemplo.com";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_SECRET: "segredo-interno-de-teste-com-32-chars",
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com",
    META_APP_ID: "1111122222",
    META_EMBEDDED_SIGNUP_CONFIG_ID: "3333344444",
    // A URL de callback da Meta sai de `basePublicaDoWebhookMeta`, que lê esta
    // variável (#1426). Vazia = cai na base da instalação, como no `.env` padrão.
    META_WEBHOOK_BASE_URL: "",
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/channels/meta/conectar", () => ({ conectarCanalOficial: vi.fn() }));
vi.mock("@/lib/channels/meta/cadastro-incorporado", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoCadastro>();
  return {
    ...real,
    appDoCadastro: vi.fn(),
    trocarCodigoPorToken: vi.fn(),
    inspecionarToken: vi.fn(),
    descobrirCanal: vi.fn(),
  };
});

import { POST as concluir } from "@/app/api/v1/channels/official/cadastro/concluir/route";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  appDoCadastro,
  descobrirCanal,
  inspecionarToken,
  trocarCodigoPorToken,
} from "@/lib/channels/meta/cadastro-incorporado";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar";
import { emitirEstadoDoCadastro } from "@/lib/channels/meta/estado-do-cadastro";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "org-1";
const USER = "user-1";
const CODE = "AQCcodeDeTesteQueNaoPodeVazar_123";
const TOKEN = "EAAGtokenDeTesteQueNaoPodeVazar";
const WABA_DA_META = "200000000000001";
const NUMERO_DA_META = "100000000000001";

let ordem: string[];
let nonces: Array<Record<string, unknown>>;
let erroDoNonce: { code: string } | null;

function state(dados = { organizationId: ORG, userId: USER }, agora = new Date()) {
  return emitirEstadoDoCadastro(dados, { segredo: SEGREDO, agora });
}

function pedido(corpo: unknown, origem: string | null = BASE) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origem) headers.origin = origem;
  return new NextRequest(`${BASE}/api/v1/channels/official/cadastro/concluir`, {
    method: "POST",
    headers,
    body: JSON.stringify(corpo),
  });
}

function corpoValido(extra: Record<string, unknown> = {}) {
  return {
    state: state(),
    code: CODE,
    evento: "FINISH",
    // Sugestão DIFERENTE do que a Meta confirma: prova que a sugestão não é a fonte.
    sugestao: { waba_id: "299999999999999", phone_number_id: "199999999999999" },
    ...extra,
  };
}

async function motivo(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { details?: { motivo?: string } } };
  return body.error?.details?.motivo;
}

beforeEach(() => {
  vi.clearAllMocks();
  ordem = [];
  nonces = [];
  erroDoNonce = null;

  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR", is_platform_admin: false, support: null },
    org: { orgId: ORG, role: "admin" },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 5, window_sec: 60 });
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => ({
      insert: async (linha: Record<string, unknown>) => {
        ordem.push(`insert:${tabela}`);
        nonces.push(linha);
        return { error: erroDoNonce };
      },
    }),
  } as never);
  vi.mocked(appDoCadastro).mockResolvedValue({ appId: "1111122222", appSecret: "segredo-do-app" });
  vi.mocked(trocarCodigoPorToken).mockImplementation(async () => {
    ordem.push("troca");
    return { ok: true, token: TOKEN };
  });
  vi.mocked(inspecionarToken).mockImplementation(async () => {
    ordem.push("inspecao");
    return { ok: true, expiraEm: "2026-11-21T00:00:00.000Z", wabasAutorizadas: [WABA_DA_META] };
  });
  vi.mocked(descobrirCanal).mockImplementation(async () => {
    ordem.push("descoberta");
    return { ok: true, wabaId: WABA_DA_META, phoneNumberId: NUMERO_DA_META };
  });
  vi.mocked(conectarCanalOficial).mockImplementation(async () => {
    ordem.push("conectar");
    return {
      ok: true,
      channelSessionId: "sessao-1",
      displayName: "Loja Teste",
      phoneNumber: "+5531900000000",
      webhookRegistro: { registrado: true, url: `${BASE}/api/v1/webhooks/meta/tok`, erro: null, em: "agora" },
    };
  });
});

function nadaVazou(resposta: unknown) {
  const tudo = JSON.stringify([resposta, vi.mocked(logger.warn).mock.calls, vi.mocked(logger.info).mock.calls, vi.mocked(logger.error).mock.calls]);
  expect(tudo).not.toContain(CODE);
  expect(tudo).not.toContain(TOKEN);
  expect(tudo).not.toContain("segredo-do-app");
}

describe("concluir o Cadastro Incorporado", () => {
  it("conecta com o que a META confirmou, na ordem certa, sem devolver segredo", async () => {
    const res = await concluir(pedido(corpoValido()));
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(ordem).toEqual(["insert:calendar_oauth_nonces", "troca", "inspecao", "descoberta", "conectar"]);
    expect(nonces[0]).toMatchObject({ organization_id: ORG, user_id: USER });
    expect(String(nonces[0]!.nonce)).toMatch(/^meta-es:[0-9a-f]{32}$/);

    expect(vi.mocked(descobrirCanal).mock.calls[0]![2]).toEqual({
      wabaId: "299999999999999",
      phoneNumberId: "199999999999999",
    });
    expect(vi.mocked(conectarCanalOficial).mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      userId: USER,
      wabaId: WABA_DA_META,
      phoneNumberId: NUMERO_DA_META,
      token: TOKEN,
      tokenExpiraEm: "2026-11-21T00:00:00.000Z",
    });
    expect(body.data).toEqual({
      connected: true,
      displayName: "Loja Teste",
      phoneNumber: "+5531900000000",
      tokenExpiraEm: "2026-11-21T00:00:00.000Z",
      webhookRegistro: { registrado: true, url: `${BASE}/api/v1/webhooks/meta/tok`, erro: null, em: "agora" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.connected",
        organizationId: ORG,
        actorUserId: USER,
        resourceId: "sessao-1",
        metadata: expect.objectContaining({ via: "cadastro_incorporado", evento: "FINISH" }),
      }),
    );
    nadaVazou(body);
  });

  it("REPLAY: nonce já queimado recusa com 409 e nunca chega à Meta", async () => {
    erroDoNonce = { code: "23505" };
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(409);
    expect(await motivo(res)).toBe("estado_reutilizado");
    expect(trocarCodigoPorToken).not.toHaveBeenCalled();
  });

  it("sem conseguir gravar o nonce, recusa (falha fechada) sem trocar o code", async () => {
    erroDoNonce = { code: "57P01" };
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(503);
    expect(trocarCodigoPorToken).not.toHaveBeenCalled();
  });

  it.each([
    ["de outra organização", { organizationId: "org-2", userId: USER }],
    ["de outra pessoa", { organizationId: ORG, userId: "user-2" }],
  ])("state %s é recusado antes de queimar ou trocar", async (_nome, dados) => {
    const res = await concluir(pedido(corpoValido({ state: state(dados) })));
    expect(res.status).toBe(403);
    expect(await motivo(res)).toBe("estado_invalido");
    expect(nonces).toHaveLength(0);
    expect(trocarCodigoPorToken).not.toHaveBeenCalled();
  });

  it("state vencido (emitido há 16 minutos) é recusado", async () => {
    const velho = state(undefined, new Date(Date.now() - 16 * 60 * 1000));
    const res = await concluir(pedido(corpoValido({ state: velho })));
    expect(res.status).toBe(403);
    expect(await motivo(res)).toBe("estado_invalido");
  });

  it("state com a assinatura adulterada é recusado", async () => {
    const original = state();
    const ultimo = original.at(-1) === "0" ? "1" : "0";
    const res = await concluir(pedido(corpoValido({ state: `${original.slice(0, -1)}${ultimo}` })));
    expect(res.status).toBe(403);
    expect(nonces).toHaveLength(0);
  });

  it("code ausente é 422 e não queima o nonce", async () => {
    const res = await concluir(pedido(corpoValido({ code: undefined })));
    expect(res.status).toBe(422);
    expect(await motivo(res)).toBe("code_ausente");
    expect(nonces).toHaveLength(0);
  });

  it.each(["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_OBO_MIGRATION"])(
    "%s não é suportado: recusa ANTES de gastar o code",
    async (evento) => {
      const res = await concluir(pedido(corpoValido({ evento })));
      expect(res.status).toBe(422);
      expect(await motivo(res)).toBe("evento_nao_suportado");
      expect(nonces).toHaveLength(0);
      expect(trocarCodigoPorToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sem Origin", null],
    ["de outra origem", "https://atacante.exemplo"],
  ])("pedido %s é recusado", async (_nome, origem) => {
    const res = await concluir(pedido(corpoValido(), origem));
    expect(res.status).toBe(403);
    expect(await motivo(res)).toBe("origem_invalida");
    expect(nonces).toHaveLength(0);
  });

  it("id sugerido que não é só dígitos é corpo inválido", async () => {
    const res = await concluir(pedido(corpoValido({ sugestao: { waba_id: "1 or 1=1" } })));
    expect(res.status).toBe(422);
    expect(await motivo(res)).toBe("corpo_invalido");
  });

  it("guarda de papel devolve a resposta dela (não-admin não entra)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as never);
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(403);
    expect(trocarCodigoPorToken).not.toHaveBeenCalled();
  });

  it("rate limit estourado é 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 6, limit: 5, window_sec: 60 });
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it.each([
    ["code_expirado", 422],
    ["code_usado", 409],
    ["app_recusado", 409],
    ["meta_indisponivel", 502],
  ] as const)("troca recusada (%s) vira %i com o motivo, sem vazar nada", async (m, status) => {
    vi.mocked(trocarCodigoPorToken).mockResolvedValue({ ok: false, motivo: m, erro: { status: 400, code: 100 } });
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(status);
    expect(await motivo(res)).toBe(m);
    expect(conectarCanalOficial).not.toHaveBeenCalled();
    nadaVazou(null);
  });

  it("token de outro app e WABA não autorizada são recusados antes de gravar", async () => {
    vi.mocked(inspecionarToken).mockResolvedValueOnce({ ok: false, motivo: "token_de_outro_app" });
    let res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(409);

    vi.mocked(descobrirCanal).mockResolvedValueOnce({ ok: false, motivo: "waba_nao_autorizada" });
    res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(403);
    expect(await motivo(res)).toBe("waba_nao_autorizada");
    expect(conectarCanalOficial).not.toHaveBeenCalled();
  });

  it("número já ativo em outra organização é 409", async () => {
    vi.mocked(conectarCanalOficial).mockResolvedValue({ ok: false, motivo: "numero_em_outra_organizacao" });
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(409);
    expect(await motivo(res)).toBe("numero_em_outra_organizacao");
    expect(audit).not.toHaveBeenCalled();
  });

  it("cadastro não configurado na instalação é 409", async () => {
    vi.mocked(appDoCadastro).mockResolvedValue(null);
    const res = await concluir(pedido(corpoValido()));
    expect(res.status).toBe(409);
    expect(await motivo(res)).toBe("cadastro_indisponivel");
    expect(nonces).toHaveLength(0);
  });
});
