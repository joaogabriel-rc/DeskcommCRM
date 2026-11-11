/**
 * DE PONTA A PONTA: as mensagens que o banco recusava entram, e apagar/editar
 * altera a original — nas duas rotas do webhook da Meta.
 *
 * O banco falso aplica a CONSTRAINT REAL: os valores de `messages_type_check`
 * são lidos da última definição do `supabase/baseline.sql`, e um `type` fora
 * dela devolve o mesmo 23514 que derrubou 183 mensagens na produção entre 01 e
 * 08/11/2026. Aplica também o `unique (organization_id, external_id)`.
 *
 * Roda de verdade: as rotas, o parser, a ingestão da recebida e do eco, a
 * alteração (`alteracao-de-mensagem.ts`) e o classificador de falha. Dublê só no
 * PostgREST e nos efeitos depois da gravação.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "app-secret-de-teste-dos-tipos";

vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: vi.fn(async () => ({ appSecret: SEGREDO, verifyToken: "v" })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock(import("@/lib/escalacao/atendimento-manual"), async (importOriginal) => ({
  ...(await importOriginal()),
  pausarIaPorAtendimentoManual: vi.fn(async () => true),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: vi.fn(async () => false),
  registrarMensagemIgnorada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: vi.fn(async () => null),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => undefined),
}));
vi.mock(import("@/lib/leads/atribuicao-de-anuncio"), async (importOriginal) => ({
  ...(await importOriginal()),
  estamparAtribuicaoDoContato: vi.fn(async () => undefined),
}));
vi.mock(import("@/lib/channels/meta/ecos-em-espera"), async (importOriginal) => ({
  ...(await importOriginal()),
  lerOnboardingDoCanal: vi.fn(async () => null),
}));

import { POST as POST_TOKEN } from "@/app/api/v1/webhooks/meta/[token]/route";
import { POST as POST_UNIVERSAL } from "@/app/api/v1/webhooks/meta/route";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { PENDENCIA_DE_ALTERACAO } from "@/lib/channels/meta/alteracao-de-mensagem";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── A constraint de verdade ─────────────────────────────────────────────────
const TIPOS_ACEITOS = (() => {
  const b = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const i = b.lastIndexOf("add constraint messages_type_check");
  const trecho = b
    .slice(i, b.indexOf("]", i))
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return new Set([...trecho.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
})();

const ORG_A = "org-a";
const ORG_B = "org-b";
const TOKEN_A = "token-tipos-a";
const TOKEN_B = "token-tipos-b";
const NUM_A = "300000000000001";
const NUM_B = "300000000000002";
const WABA_A = "400000000000001";
const WABA_B = "400000000000002";

type Linha = Record<string, unknown>;
type Erro = { code: string; message: string };
const TIMEOUT: Erro = { code: "57014", message: "canceling statement due to statement timeout" };

interface Banco {
  sessoes: Linha[];
  contatos: Map<string, string>;
  conversas: Map<string, string>;
  mensagens: Linha[];
  arquivo: Linha[];
  falhas: Record<string, Array<Erro | null>>;
  /**
   * Quantas vezes um UPDATE em `messages` encontra a linha mudada por OUTRA
   * escrita entre a leitura e o update (o `updated_at` andou) — simula a tela
   * ocultando a mensagem no mesmo instante.
   */
  conflitos: number;
}
let banco: Banco;

/** `updated_at` que sempre anda — como o trigger `trg_messages_updated_at`. */
let relogio = 0;
function carimbo(): string {
  relogio += 1;
  return new Date(Date.UTC(2026, 10, 8, 12, 0, 0, relogio)).toISOString();
}

function proximaFalha(alvo: string): Erro | null {
  const fila = banco.falhas[alvo];
  return fila && fila.length > 0 ? (fila.shift() ?? null) : null;
}

/** Lê caminhos JSON (`payload_parsed->>id`, `payload_parsed->payload->>id`) e colunas comuns. */
function valor(l: Linha, coluna: string): unknown {
  if (!coluna.includes("->")) return l[coluna];
  let v: unknown = l;
  for (const p of coluna.split(/->>?/)) v = v && typeof v === "object" ? (v as Linha)[p] : undefined;
  return v ?? null;
}

function adminFalso() {
  return {
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome === "fn_upsert_wa_contact") {
        const chave = `${args.p_org}|${args.p_phone}`;
        if (!banco.contatos.has(chave))
          banco.contatos.set(chave, `contato-${banco.contatos.size + 1}`);
        return Promise.resolve({ data: banco.contatos.get(chave), error: null });
      }
      if (nome === "fn_upsert_wa_conversation") {
        const chave = `${args.p_org}|${args.p_contact}|${args.p_session}`;
        if (!banco.conversas.has(chave))
          banco.conversas.set(chave, `conversa-${banco.conversas.size + 1}`);
        return Promise.resolve({ data: banco.conversas.get(chave), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(tabela: string) {
      const eq: Linha = {};
      const is: Linha = {};
      const neq: Linha = {};
      const naoNulo: string[] = [];
      const dentro: Record<string, unknown[]> = {};
      let ou: string | null = null;
      let operacao: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let nova: Linha | null = null;
      let patch: Linha | null = null;
      let devolverLinhas = false;

      const casa = (l: Linha) =>
        Object.entries(eq).every(([c, v]) => valor(l, c) === v) &&
        Object.entries(is).every(([c, v]) => (v === null ? l[c] == null : l[c] === v)) &&
        Object.entries(neq).every(([c, v]) => l[c] !== v) &&
        naoNulo.every((c) => valor(l, c) != null) &&
        Object.entries(dentro).every(([c, vs]) => vs.includes(l[c])) &&
        (ou === null ||
          ou.split(",").some((cond) => {
            const [col, op, ...resto] = cond.split(".");
            const alvo = resto.join(".");
            if (op === "is" && alvo === "null") return l[col!] == null;
            if (op === "lt") return typeof l[col!] === "string" && (l[col!] as string) < alvo;
            return false;
          }));

      const tabelaDe = (): Linha[] =>
        tabela === "channel_sessions"
          ? banco.sessoes
          : tabela === "messages"
            ? banco.mensagens
            : tabela === "webhook_events_log"
              ? banco.arquivo
              : [];

      const executar = (unica: boolean) => {
        const falha = proximaFalha(`${operacao}:${tabela}`);
        if (falha) return Promise.resolve({ data: null, error: falha });

        if (operacao === "insert" && tabela === "messages") {
          const l = nova!;
          if (!TIPOS_ACEITOS.has(String(l.type))) {
            return Promise.resolve({
              data: null,
              error: {
                code: "23514",
                message:
                  'new row for relation "messages" violates check constraint "messages_type_check"',
              },
            });
          }
          if (
            banco.mensagens.some(
              (m) => m.organization_id === l.organization_id && m.external_id === l.external_id,
            )
          ) {
            return Promise.resolve({
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            });
          }
          const id = `msg-${banco.mensagens.length + 1}`;
          banco.mensagens.push({
            revoked_at: null,
            edited_at: null,
            ...l,
            id,
            updated_at: carimbo(),
          });
          return Promise.resolve({ data: { id }, error: null });
        }
        if (operacao === "insert" && tabela === "webhook_events_log") {
          banco.arquivo.push({
            id: `arq-${banco.arquivo.length + 1}`,
            ...nova!,
            received_at: new Date().toISOString(),
          });
          return Promise.resolve({ data: null, error: null });
        }
        if (operacao === "insert" || operacao === "upsert" || operacao === "delete")
          return Promise.resolve({ data: null, error: null });
        if (operacao === "update") {
          if (tabela === "messages" && banco.conflitos > 0) {
            // Outra escrita chegou primeiro: o `updated_at` mudou e o filtro por ele
            // não casa mais — zero linhas, como no Postgres.
            banco.conflitos -= 1;
            for (const l of tabelaDe().filter((m) => m.id === eq.id)) l.updated_at = carimbo();
          }
          const alvos = tabelaDe().filter(casa);
          for (const l of alvos)
            Object.assign(l, patch, tabela === "messages" ? { updated_at: carimbo() } : {});
          return Promise.resolve({
            data: devolverLinhas ? alvos.map((l) => ({ id: l.id })) : null,
            error: null,
          });
        }
        const linhas = tabelaDe().filter(casa);
        return Promise.resolve({ data: unica ? (linhas[0] ?? null) : linhas, error: null });
      };

      const q: Record<string, unknown> = {
        select: () => ((devolverLinhas = operacao === "update"), q),
        eq: (c: string, v: unknown) => ((eq[c] = v), q),
        is: (c: string, v: unknown) => ((is[c] = v), q),
        neq: (c: string, v: unknown) => ((neq[c] = v), q),
        not: (c: string, op: string, v: unknown) => {
          if (op === "is" && v === null) naoNulo.push(c);
          return q;
        },
        delete: () => ((operacao = "delete"), q),
        in: (c: string, vs: unknown[]) => ((dentro[c] = vs), q),
        or: (expr: string) => ((ou = expr), q),
        gte: () => q,
        order: () => q,
        limit: () => q,
        insert: (l: Linha) => ((operacao = "insert"), (nova = l), q),
        upsert: (l: Linha) => ((operacao = "upsert"), (nova = l), q),
        update: (p: Linha) => ((operacao = "update"), (patch = p), q),
        maybeSingle: () => executar(true),
        single: () => executar(true),
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          executar(false).then(resolve, reject),
      };
      return q;
    },
  };
}

const sessao = (id: string, org: string, token: string, numero: string, waba: string): Linha => ({
  id,
  organization_id: org,
  provider: CHANNEL_PROVIDER_META,
  webhook_path_token: token,
  meta_phone_number_id: numero,
  meta_waba_id: waba,
  archived_at: null,
});

// ─── Corpos da Meta ──────────────────────────────────────────────────────────
function recebidas(waba: string, numero: string, ...messages: Linha[]) {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          contacts: [{ wa_id: "5562988887777", profile: { name: "Cliente" } }],
          messages,
        },
      },
    ],
  };
}
function ecos(waba: string, numero: string, ...message_echoes: Linha[]) {
  return {
    id: waba,
    changes: [
      {
        field: "smb_message_echoes",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          message_echoes,
        },
      },
    ],
  };
}
const corpo = (...entry: unknown[]) => ({ object: "whatsapp_business_account", entry });
const msg = (id: string, type: string, extra: Linha = {}, ts = "1790000000"): Linha => ({
  from: "5562988887777",
  id,
  timestamp: ts,
  type,
  ...extra,
});
const eco = (id: string, type: string, extra: Linha = {}, ts = "1790000000"): Linha => ({
  from: "5562900000000",
  to: "5562988887777",
  id,
  timestamp: ts,
  type,
  ...extra,
});
const revoke = (id: string, original: string, ts = "1790000100"): Linha => ({
  from: "5562988887777",
  id,
  timestamp: ts,
  type: "revoke",
  revoke: { original_message_id: original },
});
const edit = (id: string, original: string, texto: string, ts = "1790000100"): Linha => ({
  from: "5562988887777",
  id,
  timestamp: ts,
  type: "edit",
  edit: { original_message_id: original, message: { type: "text", text: { body: texto } } },
});
const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

function entrega(url: string, c: unknown): NextRequest {
  const texto = JSON.stringify(c);
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(texto, "utf8").digest("hex")}`,
    },
    body: texto,
  });
}
const postToken = (token: string, c: unknown) =>
  POST_TOKEN(entrega(`https://crm.exemplo.com/api/v1/webhooks/meta/${token}`, c), {
    params: Promise.resolve({ token }),
  } as never);
const postUniversal = (c: unknown) =>
  POST_UNIVERSAL(entrega("https://crm.exemplo.com/api/v1/webhooks/meta", c));

const ROTAS: ReadonlyArray<[string, (c: unknown) => Promise<Response>]> = [
  ["token", (c) => postToken(TOKEN_A, c)],
  ["universal", postUniversal],
];

const daOrg = (org: string) => banco.mensagens.filter((m) => m.organization_id === org);
const porWamid = (org: string, wamid: string) =>
  banco.mensagens.find((m) => m.organization_id === org && m.external_id === wamid);

beforeEach(() => {
  vi.clearAllMocks();
  banco = {
    sessoes: [
      sessao("s-a", ORG_A, TOKEN_A, NUM_A, WABA_A),
      sessao("s-b", ORG_B, TOKEN_B, NUM_B, WABA_B),
    ],
    contatos: new Map(),
    conversas: new Map(),
    mensagens: [],
    arquivo: [],
    falhas: {},
    conflitos: 0,
  };
  vi.mocked(createAdminClient).mockImplementation(() => adminFalso() as never);
});

// ─────────────────────────────────────────────────────────────────────────────
describe.each(ROTAS)("rota %s — os tipos que o banco recusava entram", (_rota, post) => {
  it.each([
    [
      "unsupported",
      msg("wamid.u", "unsupported", {
        errors: [{ code: 131051, title: "Message type unknown" }],
        unsupported: { type: "poll_creation" },
      }),
    ],
    [
      "order",
      msg("wamid.o", "order", {
        order: {
          catalog_id: "c1",
          product_items: [
            { product_retailer_id: "p1", quantity: 1, item_price: 10, currency: "BRL" },
          ],
        },
      }),
    ],
    [
      "nfm_reply",
      msg("wamid.n", "interactive", {
        interactive: {
          type: "nfm_reply",
          nfm_reply: { name: "flow", body: "Sent", response_json: '{"nome":"Ana"}' },
        },
      }),
    ],
    ["tipo desconhecido", msg("wamid.z", "hologram", { hologram: { x: 1 } })],
  ])(
    "%s: 200, uma linha com tipo aceito e o original em metadata.meta_original",
    async (_tipo, item) => {
      const res = await post(corpo(recebidas(WABA_A, NUM_A, item)));
      expect(res.status).toBe(200);
      expect(daOrg(ORG_A)).toHaveLength(1);
      const linha = daOrg(ORG_A)[0]!;
      expect(TIPOS_ACEITOS.has(String(linha.type))).toBe(true);
      expect(linha.body).toEqual(expect.any(String));
      expect((linha.metadata as Linha).meta_original).toEqual(item);
      // Não caiu no arquivo de recusados: entrou de verdade.
      expect(banco.arquivo).toHaveLength(0);
    },
  );

  it("eco interactive da empresa entra como texto de saída, com botões", async () => {
    const item = eco("wamid.ei", "interactive", {
      interactive: {
        type: "button",
        body: { text: "Confirma?" },
        action: { buttons: [{ type: "reply", reply: { id: "s", title: "Sim" } }] },
      },
    });
    expect((await post(corpo(ecos(WABA_A, NUM_A, item)))).status).toBe(200);
    const linha = porWamid(ORG_A, "wamid.ei")!;
    expect(linha).toMatchObject({ direction: "outbound", type: "text", body: "Confirma?\n[Sim]" });
    expect((linha.metadata as Linha).origem).toBe("whatsapp_business_app");
    expect((linha.metadata as Linha).meta_original).toEqual(item);
  });

  it("unsupported é registrado SEM efeitos (sem IA, sem opt-out, sem demanda) e marcado", async () => {
    await post(
      corpo(
        recebidas(WABA_A, NUM_A, msg("wamid.u2", "unsupported", { unsupported: { type: "gif" } })),
      ),
    );
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
    expect((porWamid(ORG_A, "wamid.u2")!.metadata as Linha).conteudo_indisponivel).toBe(true);
  });

  it("order segue o fluxo normal: os efeitos rodam com o texto do pedido", async () => {
    await post(
      corpo(recebidas(WABA_A, NUM_A, msg("wamid.o2", "order", { order: { product_items: [] } }))),
    );
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aplicarEfeitosPosEntrada).mock.calls[0]![1]).toMatchObject({
      texto: expect.stringContaining("Pedido pelo catálogo"),
    });
    expect((porWamid(ORG_A, "wamid.o2")!.metadata as Linha).conteudo_indisponivel).toBeUndefined();
  });

  it("texto comum: efeitos rodam e metadata só ganha o original", async () => {
    const item = msg("wamid.t", "text", { text: { body: "oi" } });
    await post(corpo(recebidas(WABA_A, NUM_A, item)));
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(porWamid(ORG_A, "wamid.t")!.metadata).toEqual({ meta_original: item });
  });

  it("localização e reação gravam metadata.location e metadata.reaction", async () => {
    await post(
      corpo(
        recebidas(
          WABA_A,
          NUM_A,
          msg("wamid.loc", "location", {
            location: { latitude: -16.6, longitude: -49.2, name: "Loja" },
          }),
          msg("wamid.rea", "reaction", { reaction: { message_id: "wamid.alvo", emoji: "❤️" } }),
        ),
      ),
    );
    expect((porWamid(ORG_A, "wamid.loc")!.metadata as Linha).location).toEqual({
      latitude: -16.6,
      longitude: -49.2,
      name: "Loja",
    });
    expect((porWamid(ORG_A, "wamid.rea")!.metadata as Linha).reaction).toEqual({
      emoji: "❤️",
      message_id: "wamid.alvo",
    });
  });

  it("reentrega do mesmo evento não duplica", async () => {
    const c = corpo(recebidas(WABA_A, NUM_A, msg("wamid.u3", "unsupported", {})));
    await post(c);
    expect((await post(c)).status).toBe(200);
    expect(daOrg(ORG_A)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe.each(ROTAS)("rota %s — apagar e editar alteram a original", (_rota, post) => {
  const original = async (wamid = "wamid.orig", texto = "Endereço: Rua 1") =>
    post(corpo(recebidas(WABA_A, NUM_A, msg(wamid, "text", { text: { body: texto } }))));

  it("revoke depois da original: revoked_at na original, nenhuma linha nova", async () => {
    await original();
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.orig"))))).status,
    ).toBe(200);
    expect(daOrg(ORG_A)).toHaveLength(1);
    // Recebida apagada pelo contato: o conteúdo SAI (decisão de 10/11/2026,
    // `lib/messaging/apagamento.ts`). A linha fica, com a marca de quando.
    expect(porWamid(ORG_A, "wamid.orig")).toMatchObject({
      revoked_at: iso("1790000100"),
      body: null,
      metadata: expect.objectContaining({
        apagamento: expect.objectContaining({ por: "contato", conteudo: "removido" }),
      }),
    });
  });

  it("edit depois da original: corpo novo e edited_at", async () => {
    await original();
    await post(corpo(recebidas(WABA_A, NUM_A, edit("wamid.ed", "wamid.orig", "Endereço: Rua 2"))));
    expect(daOrg(ORG_A)).toHaveLength(1);
    expect(porWamid(ORG_A, "wamid.orig")).toMatchObject({
      body: "Endereço: Rua 2",
      edited_at: iso("1790000100"),
      revoked_at: null,
    });
  });

  it("revoke reentregue não muda nada (idempotente)", async () => {
    await original();
    const c = corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.orig")));
    await post(c);
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.orig", "1790009999"))));
    expect(porWamid(ORG_A, "wamid.orig")!.revoked_at).toBe(iso("1790000100"));
  });

  it("edição mais velha reentregue depois da mais nova não desfaz a mais nova", async () => {
    await original();
    await post(
      corpo(recebidas(WABA_A, NUM_A, edit("wamid.e2", "wamid.orig", "Versão 2", "1790000200"))),
    );
    await post(
      corpo(recebidas(WABA_A, NUM_A, edit("wamid.e1", "wamid.orig", "Versão 1", "1790000100"))),
    );
    expect(porWamid(ORG_A, "wamid.orig")).toMatchObject({
      body: "Versão 2",
      edited_at: iso("1790000200"),
    });
  });

  it("edição de mensagem apagada não ressuscita o texto", async () => {
    await original();
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.orig", "1790000100"))));
    await post(
      corpo(recebidas(WABA_A, NUM_A, edit("wamid.ed", "wamid.orig", "outro", "1790000200"))),
    );
    // Nem o texto antigo (apagado) nem o novo (a edição chegou depois).
    expect(porWamid(ORG_A, "wamid.orig")).toMatchObject({
      body: null,
      edited_at: null,
    });
  });

  it("revoke ANTES da original: guardado sem linha artificial; aplicado quando a original chega", async () => {
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.cedo"))))).status,
    ).toBe(200);
    expect(daOrg(ORG_A)).toHaveLength(0);
    expect(banco.arquivo).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        provider: CHANNEL_PROVIDER_META,
        event_type: PENDENCIA_DE_ALTERACAO.revoke,
        external_id: "wamid.cedo",
        status: "received",
      }),
    ]);
    // reentrega do mesmo revoke não duplica a pendência
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.cedo"))));
    expect(banco.arquivo).toHaveLength(1);

    await original("wamid.cedo", "texto apagado");
    expect(daOrg(ORG_A)).toHaveLength(1);
    expect(porWamid(ORG_A, "wamid.cedo")!.revoked_at).toBe(iso("1790000100"));
    expect(banco.arquivo[0]!.status).toBe("processed");
  });

  it("edit ANTES da original: aplicado na chegada, e NUNCA vira apagamento", async () => {
    await post(corpo(recebidas(WABA_A, NUM_A, edit("wamid.ed", "wamid.cedo", "corrigido"))));
    expect(daOrg(ORG_A)).toHaveLength(0);
    await original("wamid.cedo", "errado");
    expect(porWamid(ORG_A, "wamid.cedo")).toMatchObject({
      body: "corrigido",
      edited_at: iso("1790000100"),
      revoked_at: null,
    });
  });

  it("a aplicação da pendência falha com o banco fora: 503, e a reentrega da original aplica", async () => {
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.cedo"))));
    banco.falhas["select:webhook_events_log"] = [TIMEOUT];
    const c = corpo(recebidas(WABA_A, NUM_A, msg("wamid.cedo", "text", { text: { body: "x" } })));
    expect((await post(c)).status).toBe(503);
    expect(porWamid(ORG_A, "wamid.cedo")!.revoked_at).toBeNull();
    expect((await post(c)).status).toBe(200);
    expect(porWamid(ORG_A, "wamid.cedo")!.revoked_at).toBe(iso("1790000100"));
    expect(daOrg(ORG_A)).toHaveLength(1);
  });

  it("banco fora ao procurar a original: 503 (a Meta reentrega)", async () => {
    banco.falhas["select:messages"] = [TIMEOUT];
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.orig"))))).status,
    ).toBe(503);
  });

  it("tabela de pendências inexistente: 500, nunca 200", async () => {
    banco.falhas["insert:webhook_events_log"] = [
      { code: "42P01", message: 'relation "webhook_events_log" does not exist' },
    ];
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.nada"))))).status,
    ).toBe(500);
  });

  it("a empresa apaga e edita pelo app: alteração da mensagem dela", async () => {
    await post(
      corpo(ecos(WABA_A, NUM_A, eco("wamid.nossa", "text", { text: { body: "Preço: 100" } }))),
    );
    await post(
      corpo(
        ecos(WABA_A, NUM_A, {
          to: "5562988887777",
          id: "wamid.eed",
          timestamp: "1790000100",
          type: "edit",
          edit: {
            original_message_id: "wamid.nossa",
            message: { type: "text", text: { body: "Preço: 90" } },
          },
        }),
      ),
    );
    expect(porWamid(ORG_A, "wamid.nossa")).toMatchObject({
      direction: "outbound",
      body: "Preço: 90",
      edited_at: iso("1790000100"),
    });
    await post(
      corpo(
        ecos(WABA_A, NUM_A, {
          to: "5562988887777",
          id: "wamid.erv",
          timestamp: "1790000200",
          type: "revoke",
          revoke: { original_message_id: "wamid.nossa" },
        }),
      ),
    );
    expect(porWamid(ORG_A, "wamid.nossa")!.revoked_at).toBe(iso("1790000200"));
    expect(daOrg(ORG_A)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isolamento entre organizações", () => {
  it("o revoke da org A não toca a mensagem de mesmo wamid da org B", async () => {
    await postToken(
      TOKEN_A,
      corpo(recebidas(WABA_A, NUM_A, msg("wamid.igual", "text", { text: { body: "A" } }))),
    );
    await postToken(
      TOKEN_B,
      corpo(recebidas(WABA_B, NUM_B, msg("wamid.igual", "text", { text: { body: "B" } }))),
    );
    await postToken(TOKEN_A, corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.igual"))));
    expect(porWamid(ORG_A, "wamid.igual")!.revoked_at).toBe(iso("1790000100"));
    expect(porWamid(ORG_B, "wamid.igual")!.revoked_at).toBeNull();
  });

  it("a pendência da org A não é aplicada quando a org B grava o mesmo wamid", async () => {
    await postUniversal(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.rv", "wamid.cedo"))));
    await postUniversal(
      corpo(recebidas(WABA_B, NUM_B, msg("wamid.cedo", "text", { text: { body: "B" } }))),
    );
    expect(porWamid(ORG_B, "wamid.cedo")!.revoked_at).toBeNull();
    expect(banco.arquivo[0]).toMatchObject({ organization_id: ORG_A, status: "received" });
  });

  it("universal: entrega com as duas organizações — cada alteração na sua", async () => {
    await postUniversal(
      corpo(
        recebidas(WABA_A, NUM_A, msg("wamid.x", "text", { text: { body: "A" } })),
        recebidas(WABA_B, NUM_B, msg("wamid.x", "text", { text: { body: "B" } })),
      ),
    );
    await postUniversal(
      corpo(
        recebidas(WABA_A, NUM_A, edit("wamid.e", "wamid.x", "A2")),
        recebidas(WABA_B, NUM_B, revoke("wamid.r", "wamid.x")),
      ),
    );
    expect(porWamid(ORG_A, "wamid.x")).toMatchObject({ body: "A2", revoked_at: null });
    expect(porWamid(ORG_B, "wamid.x")).toMatchObject({ body: null, revoked_at: iso("1790000100") });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * O CONTEÚDO QUE A ALTERAÇÃO TIROU DE CIRCULAÇÃO NÃO SOBRA EM `metadata`.
 *
 * Achado na prova visual (08/11/2026): a bolha escondia, mas a API de mensagens
 * devolve `metadata` inteiro, e `meta_original` guardava o texto ANTERIOR à edição
 * e uma segunda cópia do texto APAGADO. A API lê a coluna como está
 * (`MSG_COLS` em `app/api/v1/messages/_handler.ts`), então o que importa é o que
 * fica gravado — e é o que estes casos medem, pelo JSON inteiro de `metadata`.
 */
const ANTIGO = "TEXTO-ANTIGO-QUE-NAO-PODE-SOBRAR";
const APAGADO = "TEXTO-APAGADO-QUE-NAO-PODE-SOBRAR";
const metadataDe = (org: string, wamid: string) => JSON.stringify(porWamid(org, wamid)!.metadata);
const estrutural = (wamid: string, ts = "1790000000") => ({
  id: wamid,
  from: "5562988887777",
  timestamp: ts,
  type: "text",
});

describe.each(ROTAS)("rota %s — meta_original sem o conteúdo alterado", (_rota, post) => {
  const original = (wamid: string, texto: string) =>
    post(
      corpo(
        recebidas(
          WABA_A,
          NUM_A,
          msg(wamid, "text", {
            text: { body: texto },
            context: { from: "x", id: "wamid.pai", forwarded: true },
          }),
        ),
      ),
    );

  it("edição DEPOIS da original: o texto anterior sai do original; o novo fica no body", async () => {
    await original("wamid.s1", ANTIGO);
    await post(corpo(recebidas(WABA_A, NUM_A, edit("wamid.s1e", "wamid.s1", "texto novo"))));
    const linha = porWamid(ORG_A, "wamid.s1")!;
    expect(linha.body).toBe("texto novo");
    expect(metadataDe(ORG_A, "wamid.s1")).not.toContain(ANTIGO);
    expect((linha.metadata as Linha).meta_original).toEqual({
      ...estrutural("wamid.s1"),
      context: { id: "wamid.pai", from: "x" },
    });
    expect((linha.metadata as Linha).meta_original_sanitizado).toBe("edit");
  });

  it("edição ANTES da original: a mesma limpeza quando a original chega", async () => {
    await post(corpo(recebidas(WABA_A, NUM_A, edit("wamid.s2e", "wamid.s2", "texto novo"))));
    await original("wamid.s2", ANTIGO);
    const linha = porWamid(ORG_A, "wamid.s2")!;
    expect(linha.body).toBe("texto novo");
    expect(metadataDe(ORG_A, "wamid.s2")).not.toContain(ANTIGO);
    expect((linha.metadata as Linha).meta_original_sanitizado).toBe("edit");
  });

  it("exclusão DEPOIS da original: nenhuma cópia do texto apagado em metadata", async () => {
    await original("wamid.s3", APAGADO);
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.s3r", "wamid.s3"))));
    expect(metadataDe(ORG_A, "wamid.s3")).not.toContain(APAGADO);
    expect((porWamid(ORG_A, "wamid.s3")!.metadata as Linha).meta_original_sanitizado).toBe(
      "revoke",
    );
  });

  it("exclusão ANTES da original: a mesma limpeza quando a original chega", async () => {
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.s4r", "wamid.s4"))));
    await original("wamid.s4", APAGADO);
    expect(porWamid(ORG_A, "wamid.s4")!.revoked_at).toBe(iso("1790000100"));
    expect(metadataDe(ORG_A, "wamid.s4")).not.toContain(APAGADO);
  });

  it("exclusão de pedido, localização e formulário: as cópias derivadas saem também", async () => {
    await post(
      corpo(
        recebidas(
          WABA_A,
          NUM_A,
          msg("wamid.s5o", "order", {
            order: {
              text: APAGADO,
              product_items: [{ product_retailer_id: APAGADO, quantity: 1 }],
            },
          }),
          msg("wamid.s5l", "location", {
            location: { latitude: -16.6, longitude: -49.2, name: APAGADO },
          }),
          msg("wamid.s5f", "interactive", {
            interactive: {
              type: "nfm_reply",
              nfm_reply: { response_json: JSON.stringify({ campo: APAGADO }) },
            },
          }),
        ),
      ),
    );
    await post(
      corpo(
        recebidas(
          WABA_A,
          NUM_A,
          revoke("wamid.r5o", "wamid.s5o"),
          revoke("wamid.r5l", "wamid.s5l"),
          revoke("wamid.r5f", "wamid.s5f"),
        ),
      ),
    );
    for (const w of ["wamid.s5o", "wamid.s5l", "wamid.s5f"]) {
      expect(metadataDe(ORG_A, w), w).not.toContain(APAGADO);
      const m = porWamid(ORG_A, w)!.metadata as Linha;
      expect(m.order ?? m.location ?? m.flow, w).toBeUndefined();
    }
  });

  it("campo de conteúdo NOVO da Meta, que nenhuma lista conhece, também sai (lista de permitidos)", async () => {
    await post(
      corpo(
        recebidas(
          WABA_A,
          NUM_A,
          msg("wamid.s6", "text", { text: { body: "x" }, campo_do_futuro: { texto: APAGADO } }),
        ),
      ),
    );
    await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.s6r", "wamid.s6"))));
    expect(metadataDe(ORG_A, "wamid.s6")).not.toContain(APAGADO);
  });

  it("reentregas duplicadas: o metadata fica igual (idempotente)", async () => {
    await original("wamid.s7", ANTIGO);
    const ev = corpo(recebidas(WABA_A, NUM_A, edit("wamid.s7e", "wamid.s7", "novo")));
    await post(ev);
    const depois = metadataDe(ORG_A, "wamid.s7");
    await post(ev);
    await post(
      corpo(recebidas(WABA_A, NUM_A, msg("wamid.s7", "text", { text: { body: ANTIGO } }))),
    );
    expect(metadataDe(ORG_A, "wamid.s7")).toBe(depois);
    expect(porWamid(ORG_A, "wamid.s7")!.body).toBe("novo");
  });

  it("escrita concorrente na linha (updated_at andou): relê e aplica sem perder a outra escrita", async () => {
    await original("wamid.s8", ANTIGO);
    banco.conflitos = 1;
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.s8r", "wamid.s8"))))).status,
    ).toBe(200);
    expect(porWamid(ORG_A, "wamid.s8")!.revoked_at).toBe(iso("1790000100"));
    expect(metadataDe(ORG_A, "wamid.s8")).not.toContain(ANTIGO);
  });

  it("conflito persistente: 503 (a Meta reentrega), nunca 200 com a alteração sem gravar", async () => {
    await original("wamid.s9", ANTIGO);
    banco.conflitos = 10;
    expect(
      (await post(corpo(recebidas(WABA_A, NUM_A, revoke("wamid.s9r", "wamid.s9"))))).status,
    ).toBe(503);
    expect(porWamid(ORG_A, "wamid.s9")!.revoked_at).toBeNull();
  });
});

describe("meta_original sem conteúdo alterado — isolamento", () => {
  it("a edição da org A limpa só a mensagem da org A; a de mesmo wamid na org B fica intacta", async () => {
    const texto = (t: string) => ({ text: { body: t } });
    await postToken(
      TOKEN_A,
      corpo(recebidas(WABA_A, NUM_A, msg("wamid.iso", "text", texto(ANTIGO)))),
    );
    await postToken(
      TOKEN_B,
      corpo(recebidas(WABA_B, NUM_B, msg("wamid.iso", "text", texto("conteúdo da B")))),
    );
    await postToken(
      TOKEN_A,
      corpo(recebidas(WABA_A, NUM_A, edit("wamid.isoe", "wamid.iso", "novo A"))),
    );
    expect(metadataDe(ORG_A, "wamid.iso")).not.toContain(ANTIGO);
    expect((porWamid(ORG_B, "wamid.iso")!.metadata as Linha).meta_original).toMatchObject({
      text: { body: "conteúdo da B" },
    });
    expect(
      (porWamid(ORG_B, "wamid.iso")!.metadata as Linha).meta_original_sanitizado,
    ).toBeUndefined();
  });
});
