/**
 * `conectarCanalOficial` — a persistência que o formulário manual e o Cadastro
 * Incorporado compartilham. Os caminhos do formulário (reativação, webhook,
 * ordem) já são medidos pelos testes da rota manual; aqui ficam os desfechos que
 * nasceram com a extração: `23505` com nome próprio e a validade do token num
 * update SEPARADO (banco sem a migration 0392 continua conectando).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/meta/validate-credentials", () => ({ validateMetaCredentials: vi.fn() }));
vi.mock("@/lib/channels/meta/webhook-da-sessao", () => ({ registrarWebhookDaSessao: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/channels/reactivate", () => ({ reactivateChannelSession: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { conectarCanalOficial } from "@/lib/channels/meta/conectar";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { registrarWebhookDaSessao } from "@/lib/channels/meta/webhook-da-sessao";
import { logger } from "@/lib/logger";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

interface Escrita {
  tipo: "insert" | "update";
  patch: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
}

function adminFalso(opcoes: { erroDoInsert?: { code: string; message: string }; erroDaValidade?: string } = {}) {
  const escritas: Escrita[] = [];
  const admin = {
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        is: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (patch: Record<string, unknown>) => {
          escritas.push({ tipo: "insert", patch, filtros });
          return {
            select: () => ({
              maybeSingle: async () =>
                opcoes.erroDoInsert
                  ? { data: null, error: opcoes.erroDoInsert }
                  : { data: { id: "sessao-1", webhook_path_token: "tok" }, error: null },
            }),
          };
        },
        update: (patch: Record<string, unknown>) => {
          const escrita: Escrita = { tipo: "update", patch, filtros: [] };
          escritas.push(escrita);
          const u = {
            eq: (c: string, v: unknown) => {
              escrita.filtros.push([c, v]);
              return u;
            },
            then: (resolve: (r: unknown) => void) =>
              resolve({ error: opcoes.erroDaValidade ? { message: opcoes.erroDaValidade } : null }),
          };
          return u;
        },
      };
      return q;
    },
  };
  return { admin: admin as never, escritas };
}

const ENTRADA = {
  organizationId: "org-1",
  userId: "user-1",
  requestId: "req-1",
  phoneNumberId: "100000000000001",
  wabaId: "200000000000001",
  token: "EAAGtoken",
  base: "https://crm.exemplo.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateMetaCredentials).mockResolvedValue({
    ok: true,
    displayPhoneNumber: "+55 31 90000-0000",
    verifiedName: "Loja Teste",
    qualityRating: "GREEN",
  });
  vi.mocked(encryptWebhookSecret).mockResolvedValue("cifrado" as never);
  vi.mocked(registrarWebhookDaSessao).mockResolvedValue({ registrado: true, url: "u", erro: null, em: "e" });
});

describe("conectarCanalOficial", () => {
  it("cria a sessão cifrada da organização e grava a validade num update à parte, filtrado por organização", async () => {
    const { admin, escritas } = adminFalso();
    const r = await conectarCanalOficial({ ...ENTRADA, admin, tokenExpiraEm: "2026-11-21T00:00:00.000Z" });

    expect(r).toMatchObject({ ok: true, channelSessionId: "sessao-1", displayName: "Loja Teste", phoneNumber: "+5531900000000" });
    expect(escritas[0]).toMatchObject({ tipo: "insert" });
    expect(escritas[0]!.patch).toMatchObject({
      organization_id: "org-1",
      meta_phone_number_id: ENTRADA.phoneNumberId,
      meta_waba_id: ENTRADA.wabaId,
      meta_token_encrypted: "cifrado",
    });
    expect(escritas[0]!.patch).not.toHaveProperty("meta_token_expires_at");
    expect(JSON.stringify(escritas[0]!.patch)).not.toContain("EAAGtoken");

    const validade = escritas.find((e) => "meta_token_expires_at" in e.patch);
    expect(validade?.patch).toEqual({ meta_token_expires_at: "2026-11-21T00:00:00.000Z" });
    expect(validade?.filtros).toEqual([
      ["organization_id", "org-1"],
      ["id", "sessao-1"],
    ]);
  });

  it("sem tokenExpiraEm (fluxo manual) não toca a coluna", async () => {
    const { admin, escritas } = adminFalso();
    await conectarCanalOficial({ ...ENTRADA, admin });
    expect(escritas.some((e) => "meta_token_expires_at" in e.patch)).toBe(false);
  });

  it("banco sem a migration 0392: a validade não grava, a conexão continua", async () => {
    const { admin } = adminFalso({ erroDaValidade: 'column "meta_token_expires_at" does not exist' });
    const r = await conectarCanalOficial({ ...ENTRADA, admin, tokenExpiraEm: null });
    expect(r.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("validade"),
      expect.objectContaining({ schemaDesatualizado: true }),
    );
  });

  it("23505 (mesmo número ativo em outra organização) tem nome próprio", async () => {
    const { admin } = adminFalso({ erroDoInsert: { code: "23505", message: "duplicate key" } });
    expect(await conectarCanalOficial({ ...ENTRADA, admin })).toEqual({
      ok: false,
      motivo: "numero_em_outra_organizacao",
    });
  });

  it("credencial recusada pela Meta não grava nada", async () => {
    vi.mocked(validateMetaCredentials).mockResolvedValue({ ok: false, motivo: "número não pertence à WABA" });
    const { admin, escritas } = adminFalso();
    expect(await conectarCanalOficial({ ...ENTRADA, admin })).toEqual({
      ok: false,
      motivo: "credencial_recusada",
      detalhe: "número não pertence à WABA",
    });
    expect(escritas).toHaveLength(0);
  });

  it("sem cifra disponível, recusa em vez de gravar em claro", async () => {
    vi.mocked(encryptWebhookSecret).mockResolvedValue(null as never);
    const { admin, escritas } = adminFalso();
    expect(await conectarCanalOficial({ ...ENTRADA, admin })).toEqual({ ok: false, motivo: "cifra_indisponivel" });
    expect(escritas).toHaveLength(0);
  });
});
