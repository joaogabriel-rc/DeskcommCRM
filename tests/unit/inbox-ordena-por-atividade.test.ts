import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { ordenaPelaEspera } from "@/lib/inbox/comando-da-conversa";
import { listConversationsQuerySchema } from "@/lib/schemas";

import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * A INBOX ORDENA COMO O WHATSAPP — a conversa com a mensagem mais recente no topo.
 *
 * O defeito relatado: "conversas de dias atrás aparecem por cima, e não há como
 * mudar a ordem". A causa não era a consulta de atividade (ela sempre ordenou por
 * `last_message_at`): a aba PADRÃO da Inbox é a Fila, e a Fila ordena de propósito
 * por quem espera há MAIS tempo (#990) — a conversa parada desde ontem vinha
 * primeiro, e não existia seletor para trocar. Agora a ordem é escolhida na tela
 * (`ordem=recentes|espera`), o padrão da tela é `recentes`, e a rota sem `ordem`
 * mantém a ordem histórica para quem a chama por fora (MCP, integrações).
 *
 * Sabotagem medida: trocar `ordenaPelaEspera(q)` de volta por `ehAFila(q)` no
 * handler deixa vermelho o caso ⭐ da Fila com `ordem=recentes`.
 */

const ORG = "org-1";
const ctx = {
  organization_id: ORG,
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

function conversa(id: string, lastMessageAt: string, awaitingSince: string | null = null) {
  return {
    id,
    organization_id: ORG,
    status: "open",
    comando_da_conversa: "aguardando",
    last_message_at: lastMessageAt,
    awaiting_since: awaitingSince,
    is_group: false,
  };
}

function banco() {
  return criarBanco({
    conversations: [
      // Esperando desde anteontem, mas SEM mensagem nova desde então.
      conversa("00000000-0000-4000-8000-00000000000a", "2026-09-27T09:00:00Z", "2026-09-27T09:00:00Z"),
      conversa("00000000-0000-4000-8000-00000000000b", "2026-09-29T08:00:00Z", "2026-09-29T08:00:00Z"),
      conversa("00000000-0000-4000-8000-00000000000c", "2026-09-28T12:00:00Z", "2026-09-28T12:00:00Z"),
      conversa("00000000-0000-4000-8000-00000000000d", "2026-09-29T10:30:00Z", "2026-09-29T10:30:00Z"),
      // De outra organização: nunca aparece, qualquer que seja a ordem.
      { ...conversa("00000000-0000-4000-8000-0000000000ff", "2026-09-30T00:00:00Z"), organization_id: "org-2" },
    ],
  });
}

async function listar(db: ReturnType<typeof banco>, query: Record<string, unknown>) {
  return listConversationsHandler(db.client as never, ctx, { limit: 50, ...query } as never);
}

const ids = (r: { conversations: Array<{ id: string }> }) => r.conversations.map((c) => c.id.slice(-1));

describe("a regra da ordem (`ordenaPelaEspera`)", () => {
  it("sem `ordem`, a Fila continua por espera e as outras abas por atividade (contrato da rota)", () => {
    expect(ordenaPelaEspera({ comando: ["aguardando"] })).toBe(true);
    expect(ordenaPelaEspera({ assigned_to: "unassigned" })).toBe(true);
    expect(ordenaPelaEspera({})).toBe(false);
  });

  it("⭐ `ordem=recentes` vence a Fila; `espera` fora da Fila não tem o que medir", () => {
    expect(ordenaPelaEspera({ comando: ["aguardando"], ordem: "recentes" })).toBe(false);
    expect(ordenaPelaEspera({ comando: ["aguardando"], ordem: "espera" })).toBe(true);
    expect(ordenaPelaEspera({ assigned_to: "me", ordem: "espera" })).toBe(false);
  });

  it("o schema aceita as duas ordens e recusa outra", () => {
    expect(listConversationsQuerySchema.safeParse({ ordem: "recentes" }).success).toBe(true);
    expect(listConversationsQuerySchema.safeParse({ ordem: "espera" }).success).toBe(true);
    expect(listConversationsQuerySchema.safeParse({ ordem: "aleatoria" }).success).toBe(false);
  });
});

describe("a lista, pelo handler, num banco em memória", () => {
  it("⭐ Fila com `ordem=recentes`: a conversa com a mensagem mais nova no topo", async () => {
    const r = await listar(banco(), { comando: ["aguardando"], ordem: "recentes" });
    expect(ids(r)).toEqual(["d", "b", "c", "a"]);
  });

  it("CONTROLE: Fila com `ordem=espera` segue quem espera há mais tempo primeiro", async () => {
    const r = await listar(banco(), { comando: ["aguardando"], ordem: "espera" });
    expect(ids(r)).toEqual(["a", "c", "b", "d"]);
  });

  it("uma mensagem nova REPOSICIONA a conversa: a antiga sobe para o topo", async () => {
    const db = banco();
    // O que `fn_mark_conversation_message` grava ao chegar mensagem:
    // `last_message_at = greatest(last_message_at, p_at)`.
    const antiga = db.tabelas.conversations!.find((c) => String(c.id).endsWith("a"))!;
    antiga.last_message_at = "2026-09-29T11:00:00Z";

    const r = await listar(db, { comando: ["aguardando"], ordem: "recentes" });
    expect(ids(r)).toEqual(["a", "d", "b", "c"]);
  });

  it("a paginação mantém a ordem: páginas sem repetição nem buraco, e a antiga não passa a recente", async () => {
    const db = banco();
    const p1 = await listar(db, { ordem: "recentes", limit: 2 });
    expect(ids(p1)).toEqual(["d", "b"]);
    expect(p1.has_more).toBe(true);
    expect(p1.cursor).toBeTruthy();

    const p2 = await listar(db, { ordem: "recentes", limit: 2, cursor: p1.cursor });
    expect(ids(p2)).toEqual(["c", "a"]);
    expect(p2.has_more).toBe(false);
  });

  it("empate no instante: o desempate por id é determinístico entre páginas", async () => {
    const db = criarBanco({
      conversations: [
        conversa("00000000-0000-4000-8000-000000000001", "2026-09-29T10:00:00Z"),
        conversa("00000000-0000-4000-8000-000000000002", "2026-09-29T10:00:00Z"),
        conversa("00000000-0000-4000-8000-000000000003", "2026-09-29T10:00:00Z"),
      ],
    });
    const p1 = await listar(db, { ordem: "recentes", limit: 2 });
    const p2 = await listar(db, { ordem: "recentes", limit: 2, cursor: p1.cursor });
    expect([...ids(p1), ...ids(p2)]).toEqual(["3", "2", "1"]);
  });

  it("isolamento: a conversa de outra organização nunca entra, em nenhuma ordem", async () => {
    for (const ordem of ["recentes", "espera"]) {
      const r = await listar(banco(), { comando: ["aguardando"], ordem });
      expect(r.conversations.every((c) => (c as { organization_id?: string }).organization_id === ORG)).toBe(true);
    }
  });
});

describe("a tela pede a ordem sempre", () => {
  const raiz = process.cwd();
  const fonte = (p: string) => readFileSync(join(raiz, p), "utf8");

  it("o hook serializa `ordem` e a rota a lê — sem uma das pontas, a tela mostraria uma ordem e a lista outra", () => {
    expect(fonte("hooks/inbox/useConversationsRealtime.ts")).toMatch(/qs\.set\("ordem", filters\.ordem\)/);
    expect(fonte("app/api/v1/conversations/route.ts")).toMatch(/ordem: url\.searchParams\.get\("ordem"\)/);
  });

  it("o padrão da tela é `recentes` (a ordem do WhatsApp)", () => {
    expect(fonte("components/inbox/InboxLayout.tsx")).toMatch(/ordem: filterValue\.ordem \?\? "recentes"/);
  });

  it("a lista só numera \"1º, 2º…\" quando ordena pela espera", () => {
    expect(fonte("components/inbox/ConversationList.tsx")).toMatch(/const isQueue = ordenaPelaEspera\(filters\)/);
  });
});
