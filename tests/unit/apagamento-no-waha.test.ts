/**
 * WAHA (canal por QR): "apagar para todos" entrega cada alvo ao ponto único do
 * apagamento (`lib/messaging/apagamento.ts`) e NÃO engole a falha.
 *
 * Antes o handler fazia um `update` cujo erro era descartado: com o banco fora,
 * o webhook respondia 200, o WAHA não reentregava e o conteúdo apagado pelo
 * contato ficava para sempre. Agora falha passageira vira
 * `FalhaTransitoriaDeIngestao` (a rota responde 503 e o WAHA reentrega).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apagadas: Array<{ organizationId: string; messageId: string; canal: string }> = [];
let resultado: unknown = { status: "apagada" };
vi.mock("@/lib/messaging/apagamento", () => ({
  apagarMensagem: async (_a: unknown, alvo: { organizationId: string; messageId: string; canal: string }) => {
    apagadas.push({ organizationId: alvo.organizationId, messageId: alvo.messageId, canal: alvo.canal });
    return resultado;
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { FalhaPermanenteDeIngestao, FalhaTransitoriaDeIngestao } from "@/lib/waha/falha-transitoria";

let filtros: Array<[string, unknown]> = [];
let linhas: unknown[] = [{ id: "m1" }];
let erroDaBusca: { code: string; message: string } | null = null;

const admin = {
  from: (t: string) => {
    expect(t).toBe("messages");
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      then: (ok: (v: unknown) => unknown) => ok({ data: erroDaBusca ? null : linhas, error: erroDaBusca }),
    };
    return q;
  },
} as never;

const sessao = { id: "s1", organization_id: "org-a" } as never;
const revogar = (revokedMessageId: string | undefined) =>
  dispatchWahaEvent(admin, sessao, { event: "message.revoked", payload: { revokedMessageId } } as never, "req");

beforeEach(() => {
  apagadas.length = 0;
  filtros = [];
  linhas = [{ id: "m1" }];
  erroDaBusca = null;
  resultado = { status: "apagada" };
});

describe("WAHA — message.revoked", () => {
  it("busca pela ORIGINAL, na organização da sessão, e entrega ao ponto único", async () => {
    await revogar("true_5562999999999@c.us_ABCDEF");
    expect(Object.fromEntries(filtros)).toMatchObject({ organization_id: "org-a", external_id: "ABCDEF" });
    expect(apagadas).toEqual([{ organizationId: "org-a", messageId: "m1", canal: "waha" }]);
  });

  it("mais de uma linha com o mesmo id (envio + eco): cada uma é apagada", async () => {
    linhas = [{ id: "m1" }, { id: "m2" }];
    await revogar("ABCDEF");
    expect(apagadas.map((a) => a.messageId)).toEqual(["m1", "m2"]);
  });

  it("sem id da original não há o que apagar — e nada é consultado", async () => {
    await revogar(undefined);
    expect(filtros).toEqual([]);
    expect(apagadas).toEqual([]);
  });

  it("mensagem desconhecida: nada a fazer, sem erro", async () => {
    linhas = [];
    await expect(revogar("ABCDEF")).resolves.toBeUndefined();
    expect(apagadas).toEqual([]);
  });

  it("banco fora na busca → falha TRANSITÓRIA (503 e reentrega), não silêncio", async () => {
    erroDaBusca = { code: "08006", message: "conexão caiu" };
    await expect(revogar("ABCDEF")).rejects.toBeInstanceOf(FalhaTransitoriaDeIngestao);
  });

  it("apagamento que falha por banco fora → TRANSITÓRIA", async () => {
    resultado = { status: "falhou", tabela: "event_log", erro: { code: "57014", message: "timeout" } };
    await expect(revogar("ABCDEF")).rejects.toBeInstanceOf(FalhaTransitoriaDeIngestao);
  });

  it("apagamento recusado estruturalmente → PERMANENTE (nunca um 200 calado)", async () => {
    resultado = { status: "falhou", tabela: "messages", erro: { code: "42501", message: "permission denied" } };
    await expect(revogar("ABCDEF")).rejects.toBeInstanceOf(FalhaPermanenteDeIngestao);
  });
});
