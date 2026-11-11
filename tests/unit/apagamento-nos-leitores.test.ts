/**
 * Defesa na LEITURA: a recebida apagada pelo contato não sai pela API de
 * mensagens (que também serve a MCP), nem entra no contexto do agente, nem na
 * base de conhecimento — mesmo que a linha ainda guarde o corpo (linha apagada
 * antes da regra de 10/11/2026, ou lida no meio do apagamento).
 *
 * A enviada apagada pela empresa segue intacta: "Visível só aqui no CRM".
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { loadHistoryWithBudget } from "@/lib/ai/runtime/history";

const linhas = [
  { id: "m1", direction: "inbound", body: "oi", revoked_at: null, sent_at: "2026-11-10T10:00:01Z", metadata: {} },
  {
    id: "m2",
    direction: "inbound",
    body: "SEGREDO apagado pelo contato",
    media_url: "https://cdn/x.jpg",
    revoked_at: "2026-11-10T10:05:00Z",
    sent_at: "2026-11-10T10:00:02Z",
    metadata: { caption: "SEGREDO", raw_type: "image" },
  },
  {
    id: "m3",
    direction: "outbound",
    body: "texto da empresa, apagado",
    revoked_at: "2026-11-10T10:06:00Z",
    sent_at: "2026-11-10T10:00:03Z",
    metadata: {},
  },
];

/** Devolve as linhas em ordem DECRESCENTE, como as duas consultas pedem. */
const supabase = {
  from: () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      then: (ok: (v: unknown) => unknown) =>
        ok({ data: structuredClone(linhas).reverse(), error: null }),
    };
    return q;
  },
} as never;

describe("API de mensagens (e a MCP, que lê por ela)", () => {
  it("a recebida apagada sai sem corpo, sem mídia e sem conteúdo no metadata", async () => {
    const r = await listMessagesHandler(
      supabase,
      { organization_id: "org", requestId: "r", actor: { type: "user", id: "u" } } as never,
      "c1",
      { limit: 50 } as never,
    );
    const m2 = r.messages.find((m) => m.id === "m2")!;
    expect(m2.body).toBeNull();
    expect(m2.media_url).toBeNull();
    expect(JSON.stringify(m2.metadata)).not.toMatch(/SEGREDO/);
    expect(m2.revoked_at).toBe("2026-11-10T10:05:00Z");
  });

  it("a enviada apagada pela empresa continua com o texto (Visível só aqui no CRM)", async () => {
    const r = await listMessagesHandler(
      supabase,
      { organization_id: "org", requestId: "r", actor: { type: "user", id: "u" } } as never,
      "c1",
      { limit: 50 } as never,
    );
    expect(r.messages.find((m) => m.id === "m3")!.body).toBe("texto da empresa, apagado");
    expect(r.messages.find((m) => m.id === "m1")!.body).toBe("oi");
  });
});

describe("contexto do agente", () => {
  it("a recebida apagada não entra no histórico; a enviada apagada e a viva entram", async () => {
    const h = await loadHistoryWithBudget(supabase, {
      conversationId: "c1",
      organizationId: "org",
      messageWindow: 10,
      tokenWindow: 10_000,
    });
    const texto = h.map((m) => m.content).join("|");
    expect(texto).not.toMatch(/SEGREDO/);
    expect(texto).toContain("oi");
  });
});

describe("as portas que só o código mostra", () => {
  it("a ingestão do RAG lê `revoked_at` e descarta a recebida apagada", () => {
    const fonte = readFileSync("lib/ai/rag/ingest/conversations.ts", "utf8");
    expect(fonte).toMatch(/select\("body, direction, sent_at, revoked_at"\)/);
    expect(fonte).toMatch(/!\(m\.direction === "inbound" && m\.revoked_at\)/);
  });

  it("o inbox do super-admin mascara a recebida apagada", () => {
    const fonte = readFileSync("app/api/v1/admin/inbox/conversations/[id]/route.ts", "utf8");
    expect(fonte).toMatch(/revoked_at,/);
    expect(fonte).toMatch(/\.map\(semConteudoApagado\)/);
  });
});
