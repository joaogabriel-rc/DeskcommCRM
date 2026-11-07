/**
 * WEBHOOK DA META: 200 SÓ QUANDO O EVENTO FICOU GRAVADO.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 * Depois de achar a sessão, a ingestão devolvia `{ status: "failed" }` para
 * QUALQUER falha de banco — e as duas rotas respondiam 200 com
 * `outcomes: ["failed"]`. Para a Meta, 200 é "entregue": a mensagem do cliente
 * que não coube no banco num minuto de instabilidade nunca mais voltava. O
 * mesmo com o "entregue/lido/falhou" de uma mensagem nossa: o `{ error }` do
 * update era descartado.
 *
 * ─── O contrato ──────────────────────────────────────────────────────────────
 *   - gravou ............................................. 200
 *   - não gravou, causa passageira (rede, timeout, 08/53/57) 503 + Retry-After
 *   - não gravou, causa permanente (22xxx/23xxx) ......... 200 + motivo no log
 *   - reentrega de quem já entrou ........................ 200 `duplicate`
 * E reentregar é SEGURO: contato e conversa são upserts, e a mensagem tem
 * `unique (organization_id, external_id)` — este arquivo mede isso com um banco
 * falso que aplica o unique de verdade, inclusive com duas entregas simultâneas.
 *
 * Roda DE VERDADE: as duas rotas, a busca da sessão, `ingestMetaInbound`,
 * `ingestMetaEcho`, `processarEventoDaMeta` e o classificador de falha. Dublê só
 * no PostgREST e nos efeitos posteriores à gravação (pós-entrada, carimbo,
 * auditoria), que têm testes próprios.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "app-secret-de-teste-da-gravacao";

vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn(async () => ({ appSecret: SEGREDO, verifyToken: "v" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock(import("@/lib/escalacao/atendimento-manual"), async (importOriginal) => ({
  ...(await importOriginal()),
  pausarIaPorAtendimentoManual: vi.fn(async () => true),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: vi.fn(async () => false),
  registrarMensagemIgnorada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn(async () => null) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
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
import { ehFalhaTransitoriaDoBanco } from "@/lib/channels/falha-do-banco";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
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
type Erro = { code: string; message: string };

const FETCH_FAILED: Erro = { code: "", message: "TypeError: fetch failed" };
const TIMEOUT: Erro = { code: "57014", message: "canceling statement due to statement timeout" };
const CHECK_VIOLADO: Erro = { code: "23514", message: 'new row violates check constraint "messages_type_check"' };
const TEXTO_INVALIDO: Erro = { code: "22P02", message: "invalid input syntax for type uuid" };

/**
 * Banco em memória. `falhas[alvo]` é uma fila: cada chamada àquele alvo consome
 * a próxima entrada (`null` = responde normalmente). Assim um caso diz "a 1ª
 * gravação falha, a 2ª passa" — que é exatamente uma reentrega.
 */
interface Banco {
  sessoes: Linha[];
  contatos: Map<string, string>;
  conversas: Map<string, string>;
  mensagens: Linha[];
  atualizacoes: Array<{ tabela: string; patch: Linha; filtros: Linha }>;
  falhas: Record<string, Array<Erro | null>>;
}
let banco: Banco;

function proximaFalha(alvo: string): Erro | null {
  const fila = banco.falhas[alvo];
  return fila && fila.length > 0 ? (fila.shift() ?? null) : null;
}

function adminFalso() {
  return {
    rpc(nome: string, args: Record<string, unknown>) {
      const falha = proximaFalha(`rpc:${nome}`);
      if (falha) return Promise.resolve({ data: null, error: falha });
      if (nome === "fn_upsert_wa_contact") {
        const chave = `${args.p_org}|${args.p_phone}`;
        if (!banco.contatos.has(chave)) banco.contatos.set(chave, `contato-${banco.contatos.size + 1}`);
        return Promise.resolve({ data: banco.contatos.get(chave), error: null });
      }
      if (nome === "fn_upsert_wa_conversation") {
        const chave = `${args.p_org}|${args.p_contact}|${args.p_session}`;
        if (!banco.conversas.has(chave)) banco.conversas.set(chave, `conversa-${banco.conversas.size + 1}`);
        return Promise.resolve({ data: banco.conversas.get(chave), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(tabela: string) {
      const filtros: Linha = {};
      let limite = Infinity;
      let operacao: "select" | "insert" | "update" = "select";
      let linhaNova: Linha | null = null;
      let patch: Linha | null = null;

      const executar = (unica: boolean) => {
        const falha = proximaFalha(`${operacao}:${tabela}`);
        if (falha) return Promise.resolve({ data: null, error: falha });

        if (operacao === "insert" && tabela === "messages") {
          const l = linhaNova!;
          // O unique (organization_id, external_id) da tabela real.
          if (banco.mensagens.some((m) => m.organization_id === l.organization_id && m.external_id === l.external_id)) {
            return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value" } });
          }
          const id = `msg-${banco.mensagens.length + 1}`;
          banco.mensagens.push({ ...l, id });
          return Promise.resolve({ data: { id }, error: null });
        }
        if (operacao === "update") {
          banco.atualizacoes.push({ tabela, patch: patch!, filtros: { ...filtros } });
          return Promise.resolve({ data: null, error: null });
        }
        const linhas = (tabela === "channel_sessions" ? banco.sessoes : [])
          .filter((l) => Object.entries(filtros).every(([c, v]) => l[c] === v))
          .slice(0, limite);
        return Promise.resolve({ data: unica ? (linhas[0] ?? null) : linhas, error: null });
      };

      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filtros[c] = v), q),
        is: (c: string, v: unknown) => ((filtros[c] = v), q),
        neq: () => q,
        in: () => q,
        gte: () => q,
        limit: (n: number) => ((limite = n), q),
        insert: (l: Linha) => ((operacao = "insert"), (linhaNova = l), q),
        update: (p: Linha) => ((operacao = "update"), (patch = p), q),
        maybeSingle: () => executar(true),
        single: () => executar(true),
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => executar(false).then(resolve, reject),
      };
      return q;
    },
  };
}

function sessao(id: string, org: string, token: string, numero: string, waba: string): Linha {
  return {
    id,
    organization_id: org,
    provider: CHANNEL_PROVIDER_META,
    webhook_path_token: token,
    meta_phone_number_id: numero,
    meta_waba_id: waba,
    archived_at: null,
  };
}

// ─── Corpos da Meta ──────────────────────────────────────────────────────────
function mensagens(waba: string, numero: string, ...wamids: string[]) {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          contacts: [{ wa_id: "5562988887777", profile: { name: "Cliente" } }],
          messages: wamids.map((id) => ({ id, from: "5562988887777", timestamp: "1790000000", type: "text", text: { body: "oi" } })),
        },
      },
    ],
  };
}

function status(waba: string, numero: string, wamid: string, s = "delivered") {
  return {
    id: waba,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          statuses: [{ id: wamid, status: s, recipient_id: "5562988887777" }],
        },
      },
    ],
  };
}

function eco(waba: string, numero: string, wamid: string) {
  return {
    id: waba,
    changes: [
      {
        field: "smb_message_echoes",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5562900000000", phone_number_id: numero },
          message_echoes: [{ from: "5562900000000", to: "5562988887777", id: wamid, timestamp: "1790000000", type: "text", text: { body: "respondi pelo app" } }],
        },
      },
    ],
  };
}

const corpo = (...entry: unknown[]) => ({ object: "whatsapp_business_account", entry });

function entrega(url: string, c: unknown): NextRequest {
  const texto = JSON.stringify(c);
  const assinatura = `sha256=${createHmac("sha256", SEGREDO).update(texto, "utf8").digest("hex")}`;
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura },
    body: texto,
  });
}

const postToken = (token: string, c: unknown) =>
  POST_TOKEN(entrega(`https://crm.exemplo.com/api/v1/webhooks/meta/${token}`, c), {
    params: Promise.resolve({ token }),
  } as never);
const postUniversal = (c: unknown) => POST_UNIVERSAL(entrega("https://crm.exemplo.com/api/v1/webhooks/meta", c));

/** As duas portas, para os cenários que valem igual nelas. */
const ROTAS: ReadonlyArray<[string, (c: unknown) => Promise<Response>]> = [
  ["token", (c) => postToken(TOKEN_A, c)],
  ["universal", postUniversal],
];

beforeEach(() => {
  vi.clearAllMocks();
  banco = {
    sessoes: [sessao("s-a", ORG_A, TOKEN_A, NUM_A, WABA_A), sessao("s-b", ORG_B, TOKEN_B, NUM_B, WABA_B)],
    contatos: new Map(),
    conversas: new Map(),
    mensagens: [],
    atualizacoes: [],
    falhas: {},
  };
  vi.mocked(createAdminClient).mockImplementation(() => adminFalso() as never);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classificador — a reentrega resolve?", () => {
  it.each([
    // ── passageiras: a reentrega resolve ──
    ["sem código (fetch failed, 522)", FETCH_FAILED, true],
    ["código do Node (ECONNRESET)", { code: "ECONNRESET", message: "socket hang up" }, true],
    ["timeout de consulta (57014)", TIMEOUT, true],
    ["banco reiniciando (57P03)", { code: "57P03", message: "the database system is starting up" }, true],
    ["conexão (08006)", { code: "08006", message: "connection failure" }, true],
    ["conexões esgotadas (53300)", { code: "53300", message: "too many connections" }, true],
    ["deadlock (40P01)", { code: "40P01", message: "deadlock detected" }, true],
    ["serialização (40001)", { code: "40001", message: "could not serialize access" }, true],
    ["lock indisponível (55P03)", { code: "55P03", message: "could not obtain lock" }, true],
    ["banco em somente leitura (25006)", { code: "25006", message: "cannot execute INSERT in a read-only transaction" }, true],
    ["PostgREST sem banco (PGRST000)", { code: "PGRST000", message: "Could not connect with the database" }, true],
    ["PostgREST pool esgotado (PGRST003)", { code: "PGRST003", message: "Timed out acquiring connection from connection pool" }, true],
    // ── estruturais e de configuração: reentregar não resolve ──
    ["tabela inexistente (42P01)", { code: "42P01", message: 'relation "public.messages" does not exist' }, false],
    ["coluna inexistente (42703)", { code: "42703", message: 'column "x" does not exist' }, false],
    ["função inexistente (42883)", { code: "42883", message: "function does not exist" }, false],
    ["permissão negada (42501)", { code: "42501", message: "permission denied for table messages" }, false],
    ["schema cache sem a coluna (PGRST204)", { code: "PGRST204", message: "Could not find the column in the schema cache" }, false],
    ["schema cache sem a tabela (PGRST205)", { code: "PGRST205", message: "Could not find the table in the schema cache" }, false],
    ["JWT inválido (PGRST301)", { code: "PGRST301", message: "JWT expired" }, false],
    ["requisição malformada (PGRST100)", { code: "PGRST100", message: "parsing error in the query string" }, false],
    // ── dado e integridade ──
    ["check violado (23514)", CHECK_VIOLADO, false],
    ["dado inválido (22P02)", TEXTO_INVALIDO, false],
    ["not null (23502)", { code: "23502", message: "null value" }, false],
    ["SQLSTATE não listado (XX000)", { code: "XX000", message: "internal error" }, false],
  ])("%s → transitória = %s", (_n, erro, esperado) => {
    expect(ehFalhaTransitoriaDoBanco(erro)).toBe(esperado);
  });

  it("sem erro não é falha", () => {
    expect(ehFalhaTransitoriaDoBanco(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe.each(ROTAS)("rota %s — mensagem recebida", (_rota, post) => {
  it("sessão válida e gravação bem-sucedida: 200 ingested, uma linha", async () => {
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.ok")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ingested"] });
    expect(banco.mensagens).toHaveLength(1);
    expect(banco.mensagens[0]).toMatchObject({ organization_id: ORG_A, external_id: "wamid.ok" });
  });

  it.each([
    ["banco indisponível na gravação da mensagem", "insert:messages", FETCH_FAILED],
    ["timeout na gravação da mensagem", "insert:messages", TIMEOUT],
    ["banco indisponível no contato", "rpc:fn_upsert_wa_contact", FETCH_FAILED],
    ["timeout na conversa", "rpc:fn_upsert_wa_conversation", TIMEOUT],
  ])("%s: 503 com Retry-After e nada de mensagem", async (_n, alvo, erro) => {
    banco.falhas[alvo] = [erro];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.x")));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    const corpoDaResposta = (await res.json()) as { error: { code: string; message: string } };
    expect(corpoDaResposta.error).toMatchObject({ code: "upstream_unavailable", message: "event_persistence_unavailable" });
    expect(banco.mensagens).toHaveLength(0);
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it.each([
    ["check violado (23514)", CHECK_VIOLADO],
    ["dado inválido (22P02)", TEXTO_INVALIDO],
  ])("erro permanente — %s: 200 com `failed` (sem reentrega em loop), e o motivo no log", async (_n, erro) => {
    banco.falhas["insert:messages"] = [erro];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.ruim")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["failed"] });
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("inbound não ingerido"));
    expect(log?.[1]).toMatchObject({ status: "failed", retentavel: false });
  });

  it.each([
    ["tabela inexistente (42P01)", { code: "42P01", message: 'relation "public.messages" does not exist' }],
    ["coluna inexistente (42703)", { code: "42703", message: 'column "media_mime" does not exist' }],
    ["schema cache sem a tabela (PGRST205)", { code: "PGRST205", message: "Could not find the table" }],
  ])("erro ESTRUTURAL na gravação — %s: 200 com `failed`, sem reentrega sem fim", async (_n, erro) => {
    banco.falhas["insert:messages"] = [erro];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.schema")));
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("inbound não ingerido"));
    expect(log?.[1]).toMatchObject({ status: "failed", retentavel: false });
  });

  it("busca da sessão DENTRO da ingestão: passageira → 503; estrutural → 200 failed", async () => {
    // A 1ª leitura de channel_sessions é a da rota (token ou número); a 2ª é a da ingestão.
    banco.falhas["select:channel_sessions"] = [null, FETCH_FAILED];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.s1")))).status).toBe(503);

    banco.falhas["select:channel_sessions"] = [null, { code: "42703", message: 'column "meta_phone_number_id" does not exist' }];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.s2")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["failed"] });
    expect(banco.mensagens).toHaveLength(0);
  });

  it("reenvio do mesmo evento depois de gravado: 200 duplicate, sem segunda linha nem segundo efeito", async () => {
    await post(corpo(mensagens(WABA_A, NUM_A, "wamid.rep")));
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.rep")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["duplicate"] });
    expect(banco.mensagens).toHaveLength(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
  });

  it("a reentrega depois do 503 grava a mensagem uma vez só", async () => {
    banco.falhas["insert:messages"] = [FETCH_FAILED];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.volta")))).status).toBe(503);
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.volta")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ingested"] });
    expect(banco.mensagens).toHaveLength(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
  });

  it("duas entregas simultâneas do mesmo evento: uma linha, um efeito, as duas 200", async () => {
    const [r1, r2] = await Promise.all([
      post(corpo(mensagens(WABA_A, NUM_A, "wamid.par"))),
      post(corpo(mensagens(WABA_A, NUM_A, "wamid.par"))),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const outcomes = [((await r1.json()) as { outcomes: string[] }).outcomes[0], ((await r2.json()) as { outcomes: string[] }).outcomes[0]];
    expect(outcomes.sort()).toEqual(["duplicate", "ingested"]);
    expect(banco.mensagens).toHaveLength(1);
    expect(banco.contatos.size).toBe(1);
    expect(banco.conversas.size).toBe(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
  });

  it("falha depois de persistência parcial (contato gravado, conversa não): 503, e a reentrega não duplica o contato", async () => {
    banco.falhas["rpc:fn_upsert_wa_conversation"] = [FETCH_FAILED];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.meio")))).status).toBe(503);
    expect(banco.contatos.size).toBe(1);
    expect(banco.mensagens).toHaveLength(0);

    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.meio")))).status).toBe(200);
    expect(banco.contatos.size).toBe(1);
    expect(banco.conversas.size).toBe(1);
    expect(banco.mensagens).toHaveLength(1);
  });

  it("lote com duas mensagens, a 2ª falha: 503; a reentrega pula a 1ª (duplicate) e grava a 2ª", async () => {
    // 1ª gravação passa, 2ª falha.
    banco.falhas["insert:messages"] = [null, FETCH_FAILED];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.l1", "wamid.l2")));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      received: 2,
      outcomes: ["ingested", "failed_retryable"].map((o) => (_rota === "token" && o === "failed_retryable" ? "failed" : o)),
    });
    expect(banco.mensagens.map((m) => m.external_id)).toEqual(["wamid.l1"]);

    const de_novo = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.l1", "wamid.l2")));
    expect(de_novo.status).toBe(200);
    expect(await de_novo.json()).toEqual({ received: 2, outcomes: ["duplicate", "ingested"] });
    expect(banco.mensagens.map((m) => m.external_id)).toEqual(["wamid.l1", "wamid.l2"]);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe.each(ROTAS)("rota %s — eco do app Business e estado de mensagem", (_rota, post) => {
  it("eco com o banco fora na conversa: 503, e a reentrega grava uma vez", async () => {
    banco.falhas["rpc:fn_upsert_wa_conversation"] = [FETCH_FAILED];
    expect((await post(corpo(eco(WABA_A, NUM_A, "wamid.eco")))).status).toBe(503);
    expect(banco.mensagens).toHaveLength(0);
    expect((await post(corpo(eco(WABA_A, NUM_A, "wamid.eco")))).status).toBe(200);
    expect(banco.mensagens).toHaveLength(1);
    expect(banco.mensagens[0]).toMatchObject({ direction: "outbound", sent_via: "external_device", organization_id: ORG_A });
  });

  it("“entregue” com o banco fora: 503 — o estado não se perde com 200", async () => {
    banco.falhas["update:messages"] = [TIMEOUT];
    const res = await post(corpo(status(WABA_A, NUM_A, "wamid.nosso")));
    expect(res.status).toBe(503);
  });

  it("“entregue” gravado: 200, escopado à organização da sessão", async () => {
    const res = await post(corpo(status(WABA_A, NUM_A, "wamid.nosso")));
    expect(res.status).toBe(200);
    expect(banco.atualizacoes).toEqual([
      expect.objectContaining({ tabela: "messages", filtros: expect.objectContaining({ organization_id: ORG_A, external_id: "wamid.nosso" }) }),
    ]);
  });

  it.each([
    ["dado inválido (22P02)", TEXTO_INVALIDO],
    ["coluna inexistente (42703)", { code: "42703", message: 'column "read_at" does not exist' }],
  ])("“entregue” recusado por erro permanente — %s: 200 (não insiste), com log", async (_n, erro) => {
    banco.falhas["update:messages"] = [erro];
    const res = await post(corpo(status(WABA_A, NUM_A, "wamid.nosso")));
    expect(res.status).toBe(200);
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("atualização de estado não gravada"));
    expect(log?.[1]).toMatchObject({ retentavel: false, organization_id: ORG_A });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isolamento entre organizações", () => {
  it("token: o mesmo wamid em duas organizações são duas mensagens, cada uma na sua", async () => {
    expect((await postToken(TOKEN_A, corpo(mensagens(WABA_A, NUM_A, "wamid.igual")))).status).toBe(200);
    expect((await postToken(TOKEN_B, corpo(mensagens(WABA_B, NUM_B, "wamid.igual")))).status).toBe(200);
    expect(banco.mensagens.map((m) => m.organization_id).sort()).toEqual([ORG_A, ORG_B]);
  });

  it("token: a falha de uma organização não vira 503 para a outra", async () => {
    banco.falhas["insert:messages"] = [FETCH_FAILED];
    expect((await postToken(TOKEN_A, corpo(mensagens(WABA_A, NUM_A, "wamid.a")))).status).toBe(503);
    expect((await postToken(TOKEN_B, corpo(mensagens(WABA_B, NUM_B, "wamid.b")))).status).toBe(200);
    expect(banco.mensagens).toEqual([expect.objectContaining({ organization_id: ORG_B, external_id: "wamid.b" })]);
  });

  it("token: token da org A com evento da WABA da org B não grava nada, nem em caso de falha", async () => {
    banco.falhas["insert:messages"] = [FETCH_FAILED];
    const res = await postToken(TOKEN_A, corpo(mensagens(WABA_B, NUM_B, "wamid.cruzado")));
    expect(res.status).toBe(200);
    expect(banco.mensagens).toHaveLength(0);
  });

  it("universal: entrega com números de duas organizações grava cada uma na sua; a falha de uma pede reentrega e a outra não duplica", async () => {
    banco.falhas["insert:messages"] = [FETCH_FAILED];
    const c = corpo(mensagens(WABA_A, NUM_A, "wamid.ua"), mensagens(WABA_B, NUM_B, "wamid.ub"));
    expect((await postUniversal(c)).status).toBe(503);
    expect(banco.mensagens).toEqual([expect.objectContaining({ organization_id: ORG_B, external_id: "wamid.ub" })]);

    const res = await postUniversal(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 2, outcomes: ["ingested", "duplicate"] });
    expect(banco.mensagens.map((m) => `${m.organization_id}:${m.external_id}`).sort()).toEqual([
      `${ORG_A}:wamid.ua`,
      `${ORG_B}:wamid.ub`,
    ]);
  });
});
