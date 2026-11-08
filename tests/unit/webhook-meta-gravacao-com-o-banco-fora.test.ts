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
// A sincronização do aviso roda DE VERDADE; o `vi.fn` em volta só deixa um caso
// fazê-la lançar (exceção é o que `processar-evento` alcança dela).
vi.mock(import("@/lib/channels/health"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, sincronizarSaudeDaConexao: vi.fn(original.sincronizarSaudeDaConexao) };
});
vi.mock(import("@/lib/channels/meta/ecos-em-espera"), async (importOriginal) => ({
  ...(await importOriginal()),
  lerOnboardingDoCanal: vi.fn(async () => null),
}));

import { POST as POST_TOKEN } from "@/app/api/v1/webhooks/meta/[token]/route";
import { POST as POST_UNIVERSAL } from "@/app/api/v1/webhooks/meta/route";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { classificarFalhaDoBanco, ehFalhaTransitoriaDoBanco } from "@/lib/channels/falha-do-banco";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
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
  /** `webhook_events_log`: o arquivo cru do evento recusado pelo próprio dado. */
  arquivo: Linha[];
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
      // `.neq()` de verdade: é por ele que a guarda de ordem dos status
      // (`naoDesfazFalha`) impede o "sent" reentregue de apagar um "failed".
      const negados: Linha = {};
      let limite = Infinity;
      let operacao: "select" | "insert" | "update" | "upsert" = "select";
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
        if (operacao === "insert" && tabela === "webhook_events_log") {
          banco.arquivo.push({ ...linhaNova! });
          return Promise.resolve({ data: null, error: null });
        }
        if (operacao === "update") {
          banco.atualizacoes.push({ tabela, patch: patch!, filtros: { ...filtros } });
          // Em `messages` o update vale de fato, com eq E neq — é o estado final
          // da linha que os casos fora de ordem medem.
          if (tabela === "messages") {
            for (const m of banco.mensagens) {
              const casa =
                Object.entries(filtros).every(([c, v]) => m[c] === v) &&
                Object.entries(negados).every(([c, v]) => m[c] !== v);
              if (casa) Object.assign(m, patch);
            }
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (operacao === "upsert") return Promise.resolve({ data: null, error: null });
        const linhas = (tabela === "channel_sessions" ? banco.sessoes : [])
          .filter((l) => Object.entries(filtros).every(([c, v]) => l[c] === v))
          .slice(0, limite);
        return Promise.resolve({ data: unica ? (linhas[0] ?? null) : linhas, error: null });
      };

      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filtros[c] = v), q),
        is: (c: string, v: unknown) => ((filtros[c] = v), q),
        neq: (c: string, v: unknown) => ((negados[c] = v), q),
        in: () => q,
        gte: () => q,
        limit: (n: number) => ((limite = n), q),
        insert: (l: Linha) => ((operacao = "insert"), (linhaNova = l), q),
        update: (p: Linha) => ((operacao = "update"), (patch = p), q),
        upsert: (l: Linha) => ((operacao = "upsert"), (linhaNova = l), q),
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

/** Mudança na conta (WABA), no formato da referência oficial do `account_update`. */
function contaMudou(waba: string, evento: string) {
  return {
    id: waba,
    changes: [
      {
        field: "account_update",
        value: {
          event: evento,
          waba_info: { waba_id: waba, owner_business_id: "300000000000001" },
          ...(evento === "ACCOUNT_RECONNECTED"
            ? {}
            : { disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" } }),
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
    arquivo: [],
    atualizacoes: [],
    falhas: {},
  };
  vi.mocked(createAdminClient).mockImplementation(() => adminFalso() as never);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classificador — três naturezas de falha", () => {
  it.each([
    // ── transitória: infraestrutura, a reentrega resolve → 503 ──
    ["sem código (fetch failed, 522)", FETCH_FAILED, "transitoria"],
    ["código do Node (ECONNRESET)", { code: "ECONNRESET", message: "socket hang up" }, "transitoria"],
    ["timeout de consulta (57014)", TIMEOUT, "transitoria"],
    ["banco reiniciando (57P03)", { code: "57P03", message: "the database system is starting up" }, "transitoria"],
    ["conexão (08006)", { code: "08006", message: "connection failure" }, "transitoria"],
    ["conexões esgotadas (53300)", { code: "53300", message: "too many connections" }, "transitoria"],
    ["deadlock (40P01)", { code: "40P01", message: "deadlock detected" }, "transitoria"],
    ["serialização (40001)", { code: "40001", message: "could not serialize access" }, "transitoria"],
    ["lock indisponível (55P03)", { code: "55P03", message: "could not obtain lock" }, "transitoria"],
    ["banco em somente leitura (25006)", { code: "25006", message: "cannot execute INSERT in a read-only transaction" }, "transitoria"],
    ["PostgREST sem banco (PGRST000)", { code: "PGRST000", message: "Could not connect with the database" }, "transitoria"],
    ["PostgREST pool esgotado (PGRST003)", { code: "PGRST003", message: "Timed out acquiring connection from connection pool" }, "transitoria"],
    // ── estrutural: defeito ou configuração do CRM → 500, nunca 200 ──
    ["tabela inexistente (42P01)", { code: "42P01", message: 'relation "public.messages" does not exist' }, "estrutural"],
    ["coluna inexistente (42703)", { code: "42703", message: 'column "x" does not exist' }, "estrutural"],
    ["função inexistente (42883)", { code: "42883", message: "function does not exist" }, "estrutural"],
    ["permissão negada (42501)", { code: "42501", message: "permission denied for table messages" }, "estrutural"],
    ["schema cache sem a coluna (PGRST204)", { code: "PGRST204", message: "Could not find the column in the schema cache" }, "estrutural"],
    ["schema cache sem a tabela (PGRST205)", { code: "PGRST205", message: "Could not find the table in the schema cache" }, "estrutural"],
    ["JWT inválido (PGRST301)", { code: "PGRST301", message: "JWT expired" }, "estrutural"],
    ["requisição malformada pelo código (PGRST100)", { code: "PGRST100", message: "parsing error in the query string" }, "estrutural"],
    ["erro interno (XX000)", { code: "XX000", message: "internal error" }, "estrutural"],
    // ── do evento: o dado deste evento é recusado → arquiva e 200 ──
    ["check violado (23514)", CHECK_VIOLADO, "do_evento"],
    ["dado inválido (22P02)", TEXTO_INVALIDO, "do_evento"],
    ["not null (23502)", { code: "23502", message: "null value" }, "do_evento"],
    ["regra levantada pelo banco (P0001)", { code: "P0001", message: "raise exception" }, "do_evento"],
  ])("%s → %s", (_n, erro, esperado) => {
    expect(classificarFalhaDoBanco(erro)).toBe(esperado);
    expect(ehFalhaTransitoriaDoBanco(erro)).toBe(esperado === "transitoria");
  });

  it("sem erro não é falha", () => {
    expect(classificarFalhaDoBanco(null)).toBeNull();
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
  ])("recusa DO EVENTO — %s: arquiva o evento cru e só então 200 `failed`", async (_n, erro) => {
    banco.falhas["insert:messages"] = [erro];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.ruim")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["failed"] });
    expect(banco.mensagens).toHaveLength(0);
    expect(banco.arquivo).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        channel_session_id: "s-a",
        provider: CHANNEL_PROVIDER_META,
        status: "error",
        event_type: "inbound_message",
        external_id: "wamid.ruim",
        error_message: expect.stringMatching(/^do_evento: mensagem: /),
      }),
    ]);
    // O conteúdo da mensagem está no arquivo — é o que permite reprocessar depois.
    expect(JSON.parse(banco.arquivo[0]!.raw_body as string)).toMatchObject({ externalId: "wamid.ruim", text: "oi" });
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("inbound não ingerido"));
    expect(log?.[1]).toMatchObject({ status: "failed", classe: "do_evento" });
  });

  it.each([
    ["passageira", FETCH_FAILED, 503],
    ["estrutural", { code: "42P01", message: 'relation "public.webhook_events_log" does not exist' }, 500],
  ])("recusa do evento e o ARQUIVO também falha (%s): não confirma — %s", async (_n, erroDoArquivo, esperado) => {
    banco.falhas["insert:messages"] = [CHECK_VIOLADO];
    banco.falhas["insert:webhook_events_log"] = [erroDoArquivo];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.semarquivo")));
    expect(res.status).toBe(esperado);
    expect(banco.arquivo).toHaveLength(0);
  });

  it.each([
    ["tabela inexistente (42P01)", { code: "42P01", message: 'relation "public.messages" does not exist' }],
    ["coluna inexistente (42703)", { code: "42703", message: 'column "media_mime" does not exist' }],
    ["schema cache sem a tabela (PGRST205)", { code: "PGRST205", message: "Could not find the table" }],
    ["permissão negada (42501)", { code: "42501", message: "permission denied for table messages" }],
  ])("erro ESTRUTURAL na gravação — %s: 500 (nunca 200), sem Retry-After, e o log pede ação", async (_n, erro) => {
    banco.falhas["insert:messages"] = [erro];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.schema")));
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: "internal_error",
      message: "event_persistence_failed",
    });
    expect(banco.mensagens).toHaveLength(0);
    expect(banco.arquivo).toHaveLength(0);
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("inbound não ingerido"));
    expect(log?.[1]).toMatchObject({ status: "failed", classe: "estrutural" });
    expect(vi.mocked(logger.error).mock.calls.some(([m]) => String(m).includes("ESTRUTURAL do CRM"))).toBe(true);
  });

  it("depois do conserto (migration aplicada), a reentrega da Meta grava a mensagem", async () => {
    banco.falhas["insert:messages"] = [{ code: "42703", message: 'column "media_mime" does not exist' }];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.conserto")))).status).toBe(500);
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.conserto")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["ingested"] });
    expect(banco.mensagens).toHaveLength(1);
  });

  it("busca da sessão DENTRO da ingestão: passageira → 503; estrutural → 500 (nunca 200)", async () => {
    // A 1ª leitura de channel_sessions é a da rota (token ou número); a 2ª é a da ingestão.
    banco.falhas["select:channel_sessions"] = [null, FETCH_FAILED];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.s1")))).status).toBe(503);

    banco.falhas["select:channel_sessions"] = [null, { code: "42703", message: 'column "meta_phone_number_id" does not exist' }];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.s2")));
    expect(res.status).toBe(500);
    expect(banco.mensagens).toHaveLength(0);
    // Um 22xxx na NOSSA consulta não é dado do evento: também é do CRM.
    banco.falhas["select:channel_sessions"] = [null, TEXTO_INVALIDO];
    expect((await post(corpo(mensagens(WABA_A, NUM_A, "wamid.s3")))).status).toBe(500);
    expect(banco.arquivo).toHaveLength(0);
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

  it("“entregue” recusado pelo próprio dado (22P02): 200 (não insiste), com log", async () => {
    banco.falhas["update:messages"] = [TEXTO_INVALIDO];
    const res = await post(corpo(status(WABA_A, NUM_A, "wamid.nosso")));
    expect(res.status).toBe(200);
    const log = vi.mocked(logger.error).mock.calls.find(([m]) => String(m).includes("atualização de estado não gravada"));
    expect(log?.[1]).toMatchObject({ classe: "do_evento", organization_id: ORG_A });
  });

  it("“entregue” com coluna inexistente (42703): 500 — estrutural não é confirmado", async () => {
    banco.falhas["update:messages"] = [{ code: "42703", message: 'column "read_at" does not exist' }];
    const res = await post(corpo(status(WABA_A, NUM_A, "wamid.nosso")));
    expect(res.status).toBe(500);
  });

  it("eco com coluna inexistente na gravação: 500", async () => {
    banco.falhas["insert:messages"] = [{ code: "42703", message: 'column "sent_via" does not exist' }];
    expect((await post(corpo(eco(WABA_A, NUM_A, "wamid.eco2")))).status).toBe(500);
    expect(banco.mensagens).toHaveLength(0);
  });

  it("lote com uma falha passageira e uma estrutural: 500 vence 503", async () => {
    banco.falhas["insert:messages"] = [FETCH_FAILED, { code: "42P01", message: "relation does not exist" }];
    const res = await post(corpo(mensagens(WABA_A, NUM_A, "wamid.p1", "wamid.p2")));
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * STATUS FORA DE ORDEM. Desde que o webhook responde 503 com o banco fora, a
 * Meta REENTREGA — e a reentrega chega depois de entregas mais novas. O caso
 * real: o "sent" leva 503, o "failed" da mesma mensagem entra, e o "sent"
 * reentregue volta por último. Sem guarda ele apagava o "failed", e a mensagem
 * que não chegou aparecia como enviada. `failed` é terminal.
 */
describe.each(ROTAS)("rota %s — status de entrega fora de ordem", (_rota, post) => {
  const nossa = (s: string) =>
    banco.mensagens.push({ id: "msg-nossa", organization_id: ORG_A, external_id: "wamid.nosso", direction: "outbound", status: s });
  const estado = () => banco.mensagens.find((m) => m.id === "msg-nossa")?.status;

  it("o “sent” reentregue depois do “failed” não desfaz a falha", async () => {
    nossa("sending");
    banco.falhas["update:messages"] = [TIMEOUT];
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "sent")))).status).toBe(503);
    expect(estado()).toBe("sending");

    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "failed")))).status).toBe(200);
    expect(estado()).toBe("failed");

    // A reentrega do "sent" chega por último: confirma (é obsoleto, não perdido)
    // e a falha continua.
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "sent")))).status).toBe(200);
    expect(estado()).toBe("failed");
  });

  it.each(["sent", "delivered", "read"])("“%s” atrasado não sobrescreve um “failed” já gravado", async (s) => {
    nossa("failed");
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", s)))).status).toBe(200);
    expect(estado()).toBe("failed");
  });

  it("na ordem normal nada muda: “sent”, “delivered” e “read” levam a mensagem a enviada", async () => {
    nossa("sending");
    for (const s of ["sent", "delivered", "read"]) {
      expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", s)))).status).toBe(200);
    }
    expect(estado()).toBe("sent");
  });

  it("o “failed” continua chegando a uma mensagem enviada, e a reentrega dele é idempotente", async () => {
    nossa("sent");
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "failed")))).status).toBe(200);
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "failed")))).status).toBe(200);
    expect(estado()).toBe("failed");
  });

  it("a guarda é por organização: o mesmo wamid “failed” na org B não trava o “sent” da org A", async () => {
    nossa("sending");
    banco.mensagens.push({ id: "msg-da-b", organization_id: ORG_B, external_id: "wamid.nosso", direction: "outbound", status: "failed" });
    expect((await post(corpo(status(WABA_A, NUM_A, "wamid.nosso", "sent")))).status).toBe(200);
    expect(estado()).toBe("sent");
    expect(banco.mensagens.find((m) => m.id === "msg-da-b")?.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * MUDANÇA NA CONTA. Os `{ error }` do `account_update` eram descartados: com o
 * banco fora, a desconexão da conta respondia 200, a Meta não reenviava, e o
 * canal seguia "Conectado" com o número fora da API.
 */
describe.each(ROTAS)("rota %s — account_update só confirma o que gravou", (_rota, post) => {
  const stopped = () =>
    banco.atualizacoes.filter((a) => a.tabela === "channel_sessions" && a.patch.status === "STOPPED");

  it("desconexão gravada: 200, o canal vira STOPPED na organização da sessão", async () => {
    const res = await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")));
    expect(res.status).toBe(200);
    expect(stopped()).toEqual([
      expect.objectContaining({ filtros: expect.objectContaining({ organization_id: ORG_A, id: "s-a" }) }),
    ]);
  });

  it("banco fora no update do canal: 503, e a reentrega grava", async () => {
    banco.falhas["update:channel_sessions"] = [TIMEOUT];
    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(503);
    expect(sincronizarSaudeDaConexao).not.toHaveBeenCalled();

    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(200);
    expect(sincronizarSaudeDaConexao).toHaveBeenCalledTimes(1);
  });

  it("rede caiu no update do canal (sem código): 503", async () => {
    banco.falhas["update:channel_sessions"] = [FETCH_FAILED];
    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(503);
  });

  it("coluna inexistente no update do canal (42703): 500 — estrutural não é confirmado", async () => {
    banco.falhas["update:channel_sessions"] = [{ code: "42703", message: 'column "last_status_change_at" does not exist' }];
    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(500);
    expect(sincronizarSaudeDaConexao).not.toHaveBeenCalled();
  });

  it("a sincronização do aviso lança sem código (rede): 503", async () => {
    vi.mocked(sincronizarSaudeDaConexao).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(503);
  });

  it("a sincronização do aviso lança com erro estrutural (42P01): 500", async () => {
    vi.mocked(sincronizarSaudeDaConexao).mockRejectedValueOnce(
      Object.assign(new Error('relation "agent_inbox_items" does not exist'), { code: "42P01" }),
    );
    expect((await post(corpo(contaMudou(WABA_A, "PARTNER_REMOVED")))).status).toBe(500);
  });

  it("reconexão: a sincronização lança → 503; gravada → 200", async () => {
    vi.mocked(sincronizarSaudeDaConexao).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await post(corpo(contaMudou(WABA_A, "ACCOUNT_RECONNECTED")))).status).toBe(503);
    expect((await post(corpo(contaMudou(WABA_A, "ACCOUNT_RECONNECTED")))).status).toBe(200);
  });

  it("evento de conta que não nos interessa continua 200 sem escrever nada", async () => {
    const res = await post(corpo(contaMudou(WABA_A, "VERIFIED_ACCOUNT")));
    expect(res.status).toBe(200);
    expect(stopped()).toHaveLength(0);
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

  it("universal: evento recusado da org A é arquivado só na org A — o evento da org B não vai junto", async () => {
    banco.falhas["insert:messages"] = [CHECK_VIOLADO];
    const res = await postUniversal(corpo(mensagens(WABA_A, NUM_A, "wamid.ra"), mensagens(WABA_B, NUM_B, "wamid.rb")));
    expect(res.status).toBe(200);
    expect(banco.arquivo).toHaveLength(1);
    expect(banco.arquivo[0]).toMatchObject({ organization_id: ORG_A, channel_session_id: "s-a", external_id: "wamid.ra" });
    expect(banco.arquivo[0]!.raw_body as string).not.toContain("wamid.rb");
    expect(banco.mensagens).toEqual([expect.objectContaining({ organization_id: ORG_B, external_id: "wamid.rb" })]);
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
