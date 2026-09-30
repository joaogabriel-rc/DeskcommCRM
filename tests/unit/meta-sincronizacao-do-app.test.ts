/**
 * Sincronização do app WhatsApp Business — a fase de PRESERVAÇÃO (0495).
 *
 * O que cada bloco tranca:
 *   - o PEDIDO: contatos antes do histórico, histórico só depois de contatos
 *     aceito, `request_id` guardado, uma vez por tipo, nova tentativa só do que
 *     falhou, nada fora das 24h, nada fora da coexistência;
 *   - a GUARDA: o `value` bruto é guardado uma vez só, na organização dona do
 *     número; a recusa 2593109 é estado; nada toca messages/conversations/contacts;
 *   - o PARSER: `history` (inclusive com `messages[]`) e `smb_app_state_sync` viram
 *     `sync_payload` e nunca mensagem recebida;
 *   - as DUAS ROTAS: HMAC, dono do número, WABA — e nenhuma ingestão chamada.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDaIngestao from "@/lib/channels/meta/ingest";
import type * as ModuloDaSessao from "@/lib/channels/meta/session";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn() }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn(async () => ({ appSecret: SEGREDO, verifyToken: "v" })) }));
vi.mock("@/lib/channels/meta/ingest", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaIngestao>();
  return { ...real, ingestMetaInbound: vi.fn(async () => ({ status: "ingested", messageId: "m", conversationId: "c" })) };
});
vi.mock("@/lib/channels/meta/ingest-eco", () => ({
  ingestMetaEcho: vi.fn(async () => ({ status: "ingested", messageId: "m", conversationId: "c" })),
}));
vi.mock("@/lib/channels/meta/session", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaSessao>();
  return { ...real, metaSessionByWebhookToken: vi.fn(async () => sessaoDoToken) };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bancoDaRota.admin }));

import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { ingestMetaEcho } from "@/lib/channels/meta/ingest-eco";
import {
  PRAZO_DA_SINCRONIZACAO_MS,
  guardarPayloadDeSincronizacao,
  lerSincronizacao,
  solicitarSincronizacaoDoApp,
} from "@/lib/channels/meta/sincronizacao";
import { parseMetaWebhook, type MetaWebhookEnvelope } from "@/lib/channels/meta/webhook";
import { logger } from "@/lib/logger";

const SEGREDO = "app-secret-da-instalacao-de-teste";
const TOKEN = "EAAGtokenQueNaoPodeVazar";
const ORG_A = "org-a";
const ORG_B = "org-b";
const NUM_A = "100000000000001";
const NUM_B = "100000000000002";
const WABA_A = "200000000000001";
const WABA_B = "200000000000002";
const ONBOARDING = "2026-09-26T00:43:08.000Z";
const DENTRO = new Date(Date.parse(ONBOARDING) + 60 * 60 * 1000);

// ─── Banco em memória que aplica filtros e unicidade de verdade ────────────

type Linha = Record<string, unknown>;
const PADROES: Record<string, Linha> = {
  meta_sincronizacoes: { status: "pendente", request_id: null, tentativa_em: null, solicitada_em: null, recebido_em: null, erro: null },
};
const UNICOS: Record<string, string[]> = {
  meta_sincronizacoes: ["channel_session_id", "onboarding_em", "tipo"],
  // A chave da 0496: a janela faz parte da identidade (`null === null`, como o `nulls not distinct`).
  meta_sincronizacao_payloads: ["channel_session_id", "onboarding_em", "campo", "payload_hash"],
};

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const tocadas: string[] = [];
  const rpcs: unknown[] = [];
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let patch: Linha = {};
    let novas: Linha[] = [];
    let ignorarDuplicadas = false;
    const exec = (): { data: unknown; error: { code: string; message: string } | null } => {
      const t = (tabelas[tabela] ??= []);
      tocadas.push(`${op}:${tabela}`);
      const casa = (l: Linha) => filtros.every((f) => f(l));
      if (op === "select") return { data: t.filter(casa).map((l) => ({ ...l })), error: null };
      if (op === "update") {
        const alvo = t.filter(casa);
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ ...l })), error: null };
      }
      for (const nova of novas) {
        const chave = UNICOS[tabela];
        const repetida = chave && t.some((l) => chave.every((c) => l[c] === nova[c]));
        if (repetida) {
          if (ignorarDuplicadas) continue;
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        t.push({ ...(PADROES[tabela] ?? {}), ...nova });
      }
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      lt: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) < v), q),
      limit: () => q,
      update: (p: Linha) => ((op = "update"), (patch = p), q),
      insert: (r: Linha | Linha[]) => ((op = "insert"), (novas = Array.isArray(r) ? r : [r]), q),
      upsert: (r: Linha[], o?: { ignoreDuplicates?: boolean }) => (
        (op = "upsert"), (novas = r), (ignorarDuplicadas = o?.ignoreDuplicates === true), q
      ),
      maybeSingle: async () => {
        const r = exec();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      then: (ok: (r: unknown) => void, erro?: (e: unknown) => void) => Promise.resolve(exec()).then(ok, erro),
    };
    return q;
  };
  const rpc = async (...args: unknown[]) => (rpcs.push(args), { data: null, error: null });
  return { admin: { from, rpc } as unknown as SupabaseClient, tabelas, tocadas, rpcs };
}

function sessao(id: string, org: string, numero: string, waba: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: org,
    provider: "meta_cloud",
    meta_phone_number_id: numero,
    meta_waba_id: waba,
    meta_modo: "coexistencia",
    meta_onboarding_em: ONBOARDING,
    archived_at: null,
    ...extra,
  };
}

function bancoComSessoes(extraA: Linha = {}) {
  return bancoFalso({
    channel_sessions: [sessao("s-a", ORG_A, NUM_A, WABA_A, extraA), sessao("s-b", ORG_B, NUM_B, WABA_B)],
    meta_sincronizacoes: [],
    meta_sincronizacao_payloads: [],
  });
}

/** A leitura da janela do payload (`channel_sessions.meta_onboarding_em`) passa a errar. */
function janelaIlegivel(admin: SupabaseClient) {
  const original = admin.from.bind(admin);
  (admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = original(t) as unknown as Record<string, unknown>;
    if (t === "channel_sessions") {
      const select = q.select as (c?: string) => unknown;
      q.select = (c?: string) => {
        if (c === "meta_onboarding_em") q.maybeSingle = async () => ({ data: null, error: { code: "57P01", message: "conexão caiu" } });
        return select(c);
      };
    }
    return q;
  };
}

// ─── Meta falsa ─────────────────────────────────────────────────────────────

let pedidosNaMeta: Array<{ url: string; syncType: string; auth: string | null }>;
let respostaDaMeta: (syncType: string) => Response;

beforeEach(() => {
  vi.clearAllMocks();
  pedidosNaMeta = [];
  respostaDaMeta = (syncType) =>
    new Response(JSON.stringify({ messaging_product: "whatsapp", request_id: `req-${syncType}` }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const syncType = JSON.parse(String(init?.body ?? "{}")).sync_type as string;
      pedidosNaMeta.push({ url, syncType, auth: new Headers(init?.headers).get("authorization") });
      return respostaDaMeta(syncType);
    }),
  );
  vi.mocked(resolveMetaCreds).mockResolvedValue({
    phoneNumberId: NUM_A,
    token: TOKEN,
    graphVersion: "v22.0",
    source: "session",
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

// ─── Pedido ─────────────────────────────────────────────────────────────────

describe("solicitarSincronizacaoDoApp", () => {
  it("pede CONTATOS antes do HISTÓRICO e guarda o request_id de cada um", async () => {
    const banco = bancoComSessoes();
    const r = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });

    expect(r).toMatchObject({ ok: true, contatos: "solicitada", historico: "solicitada" });
    expect(pedidosNaMeta.map((p) => p.syncType)).toEqual(["smb_app_state_sync", "history"]);
    expect(pedidosNaMeta[0]!.url).toBe(`https://graph.facebook.com/v22.0/${NUM_A}/smb_app_data`);
    // O token vai no cabeçalho, nunca na URL.
    expect(pedidosNaMeta[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(pedidosNaMeta.some((p) => p.url.includes(TOKEN))).toBe(false);

    const linhas = banco.tabelas.meta_sincronizacoes!;
    expect(linhas.find((l) => l.tipo === "contatos")).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: "s-a",
      onboarding_em: ONBOARDING,
      status: "solicitada",
      request_id: "req-smb_app_state_sync",
    });
    expect(linhas.find((l) => l.tipo === "historico")).toMatchObject({ status: "solicitada", request_id: "req-history" });
    expect(typeof linhas[0]!.solicitada_em).toBe("string");
  });

  it("uma segunda chamada NÃO pede de novo à Meta — um pedido por tipo", async () => {
    const banco = bancoComSessoes();
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    const segunda = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });

    expect(segunda).toMatchObject({ ok: true, contatos: "ja_solicitada", historico: "ja_solicitada" });
    expect(pedidosNaMeta).toHaveLength(2);
    expect(banco.tabelas.meta_sincronizacoes).toHaveLength(2);
  });

  it("contatos recusado pela Meta: histórico NÃO é pedido; a nova tentativa pede os dois, na ordem", async () => {
    const banco = bancoComSessoes();
    respostaDaMeta = () => new Response(JSON.stringify({ error: { code: 100, message: "Invalid parameter" } }), { status: 400 });
    const primeira = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });

    expect(primeira).toMatchObject({ ok: true, contatos: "falhou", historico: "aguardando_contatos" });
    expect(pedidosNaMeta.map((p) => p.syncType)).toEqual(["smb_app_state_sync"]);
    const contatos = banco.tabelas.meta_sincronizacoes!.find((l) => l.tipo === "contatos")!;
    expect(contatos).toMatchObject({ status: "falhou", erro: "meta_100: Invalid parameter", request_id: null });
    expect(String(contatos.erro)).not.toContain(TOKEN);

    respostaDaMeta = (t) => new Response(JSON.stringify({ request_id: `req-${t}` }), { status: 200 });
    const segunda = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    expect(segunda).toMatchObject({ contatos: "solicitada", historico: "solicitada" });
    expect(pedidosNaMeta.map((p) => p.syncType)).toEqual(["smb_app_state_sync", "smb_app_state_sync", "history"]);
    expect(banco.tabelas.meta_sincronizacoes).toHaveLength(2);
  });

  it("só o histórico falhou: a nova tentativa NÃO repete contatos", async () => {
    const banco = bancoComSessoes();
    respostaDaMeta = (t) =>
      t === "history"
        ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
        : new Response(JSON.stringify({ request_id: `req-${t}` }), { status: 200 });
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    respostaDaMeta = (t) => new Response(JSON.stringify({ request_id: `req-${t}` }), { status: 200 });
    const segunda = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });

    expect(segunda).toMatchObject({ contatos: "ja_solicitada", historico: "solicitada" });
    expect(pedidosNaMeta.map((p) => p.syncType)).toEqual(["smb_app_state_sync", "history", "history"]);
  });

  it("reserva em curso (outra chamada pedindo agora) não gera segundo pedido; reserva abandonada há >5min é retomada", async () => {
    const banco = bancoComSessoes();
    banco.tabelas.meta_sincronizacoes!.push(
      { ...PADROES.meta_sincronizacoes, organization_id: ORG_A, channel_session_id: "s-a", onboarding_em: ONBOARDING, tipo: "contatos", status: "solicitando", tentativa_em: new Date(DENTRO.getTime() - 60_000).toISOString() },
    );
    const emCurso = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    expect(emCurso).toMatchObject({ contatos: "em_andamento", historico: "aguardando_contatos" });
    expect(pedidosNaMeta).toHaveLength(0);

    const depois = new Date(DENTRO.getTime() + 10 * 60_000);
    const retomada = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: depois });
    expect(retomada).toMatchObject({ contatos: "solicitada", historico: "solicitada" });
  });

  it("fora das 24h: não chama a Meta e marca o que faltava como expirada", async () => {
    const banco = bancoComSessoes();
    const tarde = new Date(Date.parse(ONBOARDING) + PRAZO_DA_SINCRONIZACAO_MS + 1000);
    const r = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: tarde });

    expect(r).toMatchObject({ ok: true, contatos: "expirada", historico: "expirada" });
    expect(pedidosNaMeta).toHaveLength(0);
    expect(banco.tabelas.meta_sincronizacoes!.map((l) => l.status)).toEqual(["expirada", "expirada"]);
  });

  it("no limite exato do prazo ainda pede", async () => {
    const banco = bancoComSessoes();
    const limite = new Date(Date.parse(ONBOARDING) + PRAZO_DA_SINCRONIZACAO_MS);
    expect(await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: limite })).toMatchObject({
      contatos: "solicitada",
    });
  });

  it.each([
    ["cloud_api", { meta_modo: "cloud_api" }, "nao_e_coexistencia"],
    ["sem modo", { meta_modo: null }, "nao_e_coexistencia"],
    ["sem onboarding", { meta_onboarding_em: null }, "sem_onboarding"],
    ["arquivada", { archived_at: "2026-09-26T01:00:00Z" }, "sem_canal_oficial"],
  ])("canal %s não pede nada", async (_n, extra, motivo) => {
    const banco = bancoComSessoes(extra);
    expect(await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO })).toEqual({ ok: false, motivo });
    expect(pedidosNaMeta).toHaveLength(0);
  });

  it("sem credencial legível não pede", async () => {
    vi.mocked(resolveMetaCreds).mockResolvedValue(null);
    const banco = bancoComSessoes();
    expect(await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO })).toEqual({ ok: false, motivo: "sem_credencial" });
    expect(pedidosNaMeta).toHaveLength(0);
  });

  it("a organização é a de quem chama: pedir pela B nunca toca a sessão da A", async () => {
    const banco = bancoComSessoes();
    vi.mocked(resolveMetaCreds).mockResolvedValue({ phoneNumberId: NUM_B, token: TOKEN, graphVersion: "v22.0", source: "session" } as never);
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_B, agora: DENTRO });
    expect(banco.tabelas.meta_sincronizacoes!.every((l) => l.organization_id === ORG_B && l.channel_session_id === "s-b")).toBe(true);
    expect(pedidosNaMeta[0]!.url).toContain(NUM_B);
  });

  it("nenhuma escrita fora das tabelas da sincronização; nenhuma RPC", async () => {
    const banco = bancoComSessoes();
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    const tabelas = new Set(banco.tocadas.map((t) => t.split(":")[1]));
    // A quarentena dos ecos (0496) só é LIDA — é a contagem que a tela mostra.
    expect([...tabelas].sort()).toEqual(["channel_sessions", "meta_ecos_em_espera", "meta_sincronizacoes"]);
    expect(banco.tocadas.filter((t) => t.endsWith(":meta_ecos_em_espera")).every((t) => t.startsWith("select:"))).toBe(true);
    expect(banco.tocadas.filter((t) => t.startsWith("select:") === false).every((t) => t.endsWith(":meta_sincronizacoes"))).toBe(true);
    expect(banco.rpcs).toHaveLength(0);
  });

  describe("reconexão: um pedido por tipo POR onboarding", () => {
    const NOVO_ONBOARDING = "2026-10-10T12:00:00.000Z";
    const DENTRO_DO_NOVO = new Date(Date.parse(NOVO_ONBOARDING) + 60 * 60 * 1000);

    function reconectar(banco: ReturnType<typeof bancoComSessoes>) {
      banco.tabelas.channel_sessions!.find((l) => l.id === "s-a")!.meta_onboarding_em = NOVO_ONBOARDING;
    }

    it("onboarding NOVO pede de novo, na ordem, e os pedidos do anterior ficam intactos", async () => {
      const banco = bancoComSessoes();
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
      const antigos = banco.tabelas.meta_sincronizacoes!.map((l) => ({ ...l }));

      reconectar(banco);
      respostaDaMeta = (t) => new Response(JSON.stringify({ request_id: `novo-${t}` }), { status: 200 });
      const r = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO_DO_NOVO });

      expect(r).toMatchObject({ ok: true, contatos: "solicitada", historico: "solicitada" });
      expect(pedidosNaMeta.map((p) => p.syncType)).toEqual(["smb_app_state_sync", "history", "smb_app_state_sync", "history"]);
      const linhas = banco.tabelas.meta_sincronizacoes!;
      expect(linhas).toHaveLength(4);
      // O histórico do onboarding anterior não foi apagado nem reescrito.
      expect(linhas.filter((l) => l.onboarding_em === ONBOARDING)).toEqual(antigos);
      expect(linhas.filter((l) => l.onboarding_em === NOVO_ONBOARDING).map((l) => [l.tipo, l.status, l.request_id])).toEqual([
        ["contatos", "solicitada", "novo-smb_app_state_sync"],
        ["historico", "solicitada", "novo-history"],
      ]);
    });

    it("dentro do MESMO onboarding novo, continua um pedido por tipo", async () => {
      const banco = bancoComSessoes();
      reconectar(banco);
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO_DO_NOVO });
      const segunda = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO_DO_NOVO });
      expect(segunda).toMatchObject({ contatos: "ja_solicitada", historico: "ja_solicitada" });
      expect(pedidosNaMeta).toHaveLength(2);
      expect(banco.tabelas.meta_sincronizacoes).toHaveLength(2);
    });

    it("o prazo é o do onboarding da sincronização: janela anterior vencida não bloqueia a nova", async () => {
      const banco = bancoComSessoes();
      // A primeira janela venceu sem pedido: vira `expirada`.
      const vencida = new Date(Date.parse(ONBOARDING) + PRAZO_DA_SINCRONIZACAO_MS + 1000);
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: vencida });
      expect(banco.tabelas.meta_sincronizacoes!.map((l) => l.status)).toEqual(["expirada", "expirada"]);

      reconectar(banco);
      const r = await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO_DO_NOVO });
      expect(r).toMatchObject({ contatos: "solicitada", historico: "solicitada" });
      // As linhas expiradas do onboarding anterior continuam `expirada`.
      expect(banco.tabelas.meta_sincronizacoes!.filter((l) => l.onboarding_em === ONBOARDING).map((l) => l.status)).toEqual([
        "expirada",
        "expirada",
      ]);
    });

    it("o prazo do onboarding novo também vence: 24h depois DELE não pede", async () => {
      const banco = bancoComSessoes();
      reconectar(banco);
      const tarde = new Date(Date.parse(NOVO_ONBOARDING) + PRAZO_DA_SINCRONIZACAO_MS + 1000);
      expect(await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: tarde })).toMatchObject({
        contatos: "expirada",
        historico: "expirada",
      });
      expect(pedidosNaMeta).toHaveLength(0);
    });

    it("lerSincronizacao mostra só os pedidos do onboarding atual", async () => {
      const banco = bancoComSessoes();
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
      reconectar(banco);
      const s = await lerSincronizacao(banco.admin, ORG_A, DENTRO_DO_NOVO);
      expect(s).toMatchObject({ disponivel: true, onboardingEm: NOVO_ONBOARDING, contatos: null, historico: null, dentroDoPrazo: true });
    });

    it("o payload que chega atualiza o estado do onboarding ATUAL, nunca o anterior", async () => {
      const banco = bancoComSessoes();
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
      reconectar(banco);
      await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO_DO_NOVO });
      await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_RECUSADO }, { organizationId: ORG_A });

      const historicos = banco.tabelas.meta_sincronizacoes!.filter((l) => l.tipo === "historico");
      expect(historicos.find((l) => l.onboarding_em === ONBOARDING)).toMatchObject({ status: "solicitada", recebido_em: null });
      expect(historicos.find((l) => l.onboarding_em === NOVO_ONBOARDING)).toMatchObject({ status: "recusada" });
    });
  });

  it("lerSincronizacao devolve prazo e estado por tipo", async () => {
    const banco = bancoComSessoes();
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    const s = await lerSincronizacao(banco.admin, ORG_A, DENTRO);
    expect(s).toMatchObject({
      disponivel: true,
      channelSessionId: "s-a",
      prazo: new Date(Date.parse(ONBOARDING) + PRAZO_DA_SINCRONIZACAO_MS).toISOString(),
      dentroDoPrazo: true,
      contatos: { status: "solicitada", request_id: "req-smb_app_state_sync" },
      historico: { status: "solicitada", request_id: "req-history" },
    });
  });
});

// ─── Guarda do payload ─────────────────────────────────────────────────────

const VALOR_HISTORICO = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550783881", phone_number_id: NUM_A },
  history: [
    {
      metadata: { phase: 0, chunk_order: 1, progress: 55 },
      threads: [
        {
          id: "16505551234",
          messages: [
            { from: "15550783881", id: "wamid.H1", timestamp: "1739230955", type: "text", text: { body: "oi" }, history_context: { status: "READ" } },
          ],
        },
      ],
    },
  ],
};
const VALOR_CONTATOS = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550783881", phone_number_id: NUM_A },
  state_sync: [
    { type: "contact", contact: { full_name: "Pablo Morales", first_name: "Pablo", phone_number: "16505551234" }, action: "add", metadata: { timestamp: "1739321024" } },
  ],
};
const VALOR_RECUSADO = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550783881", phone_number_id: NUM_A },
  history: [{ errors: [{ code: 2593109, title: "History sync is turned off by the business from the WhatsApp Business App" }] }],
};

/** Toda RPC é o `emit_event` de `meta.historico.chunk_guardado` (0496) — e nada mais. */
function apenasOAvisoAoResolvedor(rpcs: unknown[]): boolean {
  return rpcs.every((r) => {
    const [nome, args] = r as [string, Record<string, unknown>];
    return nome === "emit_event" && args.p_event_type === "meta.historico.chunk_guardado";
  });
}

describe("guardarPayloadDeSincronizacao", () => {
  it("guarda o value BRUTO na organização e no canal donos do número, com fase/pedaço/progresso", async () => {
    const banco = bancoComSessoes();
    const r = await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_HISTORICO }, { organizationId: ORG_A });

    expect(r).toBe("guardado");
    const [linha] = banco.tabelas.meta_sincronizacao_payloads!;
    expect(linha).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: "s-a",
      campo: "history",
      payload: VALOR_HISTORICO,
      fase: 0,
      chunk_order: 1,
      progresso: 55,
    });
    expect(String(linha!.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REENTREGA do mesmo payload não duplica", async () => {
    const banco = bancoComSessoes();
    const e = { campo: "smb_app_state_sync" as const, phoneNumberId: NUM_A, value: VALOR_CONTATOS };
    expect(await guardarPayloadDeSincronizacao(banco.admin, e, { organizationId: ORG_A })).toBe("guardado");
    expect(await guardarPayloadDeSincronizacao(banco.admin, structuredClone(e), { organizationId: ORG_A })).toBe("duplicate");
    expect(banco.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
  });

  it("número de OUTRA organização não entra — no_session, nada gravado", async () => {
    const banco = bancoComSessoes();
    const r = await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_B, value: VALOR_HISTORICO }, { organizationId: ORG_A });
    expect(r).toBe("no_session");
    expect(banco.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
  });

  it("marca recebido_em no tipo certo, só na primeira vez", async () => {
    const banco = bancoComSessoes();
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    await guardarPayloadDeSincronizacao(banco.admin, { campo: "smb_app_state_sync", phoneNumberId: NUM_A, value: VALOR_CONTATOS }, { organizationId: ORG_A });
    const contatos = banco.tabelas.meta_sincronizacoes!.find((l) => l.tipo === "contatos")!;
    const historico = banco.tabelas.meta_sincronizacoes!.find((l) => l.tipo === "historico")!;
    const primeiro = contatos.recebido_em;
    expect(typeof primeiro).toBe("string");
    expect(historico.recebido_em).toBeNull();

    await guardarPayloadDeSincronizacao(banco.admin, { campo: "smb_app_state_sync", phoneNumberId: NUM_A, value: { ...VALOR_CONTATOS, extra: 1 } }, { organizationId: ORG_A });
    expect(contatos.recebido_em).toBe(primeiro);
  });

  it("recusa 2593109 marca o histórico como recusada — e guarda o payload, sem importar nada", async () => {
    const banco = bancoComSessoes();
    await solicitarSincronizacaoDoApp(banco.admin, { organizationId: ORG_A, agora: DENTRO });
    await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_RECUSADO }, { organizationId: ORG_A });
    expect(banco.tabelas.meta_sincronizacoes!.find((l) => l.tipo === "historico")).toMatchObject({ status: "recusada" });
    expect(banco.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
  });

  it("nenhuma escrita em messages, conversations ou contacts; nenhuma RPC além do aviso ao resolvedor dos ecos (0496)", async () => {
    const banco = bancoComSessoes();
    for (const [campo, value] of [["history", VALOR_HISTORICO], ["smb_app_state_sync", VALOR_CONTATOS], ["history", VALOR_RECUSADO]] as const) {
      await guardarPayloadDeSincronizacao(banco.admin, { campo, phoneNumberId: NUM_A, value }, { organizationId: ORG_A });
    }
    const tabelas = new Set(banco.tocadas.map((t) => t.split(":")[1]));
    expect([...tabelas].sort()).toEqual(["channel_sessions", "meta_sincronizacao_payloads", "meta_sincronizacoes"]);
    // O único efeito fora das tabelas da sincronização: cada pedaço de HISTORY
    // acorda o resolvedor dos ecos em espera. Nenhum fn_upsert_*, nenhum outro evento.
    expect(apenasOAvisoAoResolvedor(banco.rpcs)).toBe(true);
    expect(banco.rpcs).toHaveLength(2);
  });

  it("B1: janela do payload ilegível LANÇA antes de gravar — nenhum payload sem janela, nenhum aviso; a reentrega grava com a janela", async () => {
    const banco = bancoComSessoes();
    const original = banco.admin.from;
    janelaIlegivel(banco.admin);
    await expect(
      guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_HISTORICO }, { organizationId: ORG_A }),
    ).rejects.toThrow("channel_sessions (janela do payload)");
    expect(banco.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
    expect(banco.rpcs).toHaveLength(0);

    (banco.admin as unknown as { from: unknown }).from = original;
    expect(
      await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_HISTORICO }, { organizationId: ORG_A }),
    ).toBe("guardado");
    expect(banco.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
    expect(banco.tabelas.meta_sincronizacao_payloads![0]).toMatchObject({ onboarding_em: ONBOARDING });
    expect(apenasOAvisoAoResolvedor(banco.rpcs)).toBe(true);
  });

  it("falha do banco LANÇA — a rota responde 5xx e a Meta reentrega, em vez de perder o pedaço com 200", async () => {
    const banco = bancoComSessoes();
    const original = banco.admin.from.bind(banco.admin);
    (banco.admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = original(t) as unknown as Record<string, unknown>;
      if (t === "meta_sincronizacao_payloads") {
        q.insert = () => Promise.resolve({ error: { code: "57P01", message: "conexão caiu" } });
      }
      return q;
    };
    await expect(
      guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_A, value: VALOR_HISTORICO }, { organizationId: ORG_A }),
    ).rejects.toThrow("conexão caiu");
  });
});

// ─── Parser ─────────────────────────────────────────────────────────────────

const envelope = (...entry: unknown[]): MetaWebhookEnvelope =>
  ({ object: "whatsapp_business_account", entry }) as MetaWebhookEnvelope;
const change = (waba: string, field: string, value: unknown) => ({ id: waba, changes: [{ field, value }] });

/** O `history` que traz o id da mídia de um pedaço já entregue: `messages[]`, mas field `history`. */
const VALOR_MIDIA_DO_HISTORICO = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550783881", phone_number_id: NUM_A },
  messages: [{ from: "16505551234", id: "wamid.QyNU", timestamp: "1738796547", type: "image", image: { mime_type: "image/jpeg", id: "24230790383178626" } }],
};

describe("parseMetaWebhook — history e smb_app_state_sync", () => {
  it("viram sync_payload com o value bruto", () => {
    expect(parseMetaWebhook(envelope(change(WABA_A, "history", VALOR_HISTORICO), change(WABA_A, "smb_app_state_sync", VALOR_CONTATOS)))).toEqual([
      { kind: "sync_payload", campo: "history", wabaId: WABA_A, phoneNumberId: NUM_A, value: VALOR_HISTORICO },
      { kind: "sync_payload", campo: "smb_app_state_sync", wabaId: WABA_A, phoneNumberId: NUM_A, value: VALOR_CONTATOS },
    ]);
  });

  it("history com messages[] NUNCA vira mensagem recebida", () => {
    const eventos = parseMetaWebhook(envelope(change(WABA_A, "history", VALOR_MIDIA_DO_HISTORICO)));
    expect(eventos.map((e) => e.kind)).toEqual(["sync_payload"]);
  });

  it("sem o número dono, fica de fora", () => {
    const { metadata: _sem, ...semNumero } = VALOR_HISTORICO;
    expect(parseMetaWebhook(envelope(change(WABA_A, "history", semNumero)))).toEqual([]);
  });

  it("regressão: messages e smb_message_echoes seguem como estavam na mesma entrega", () => {
    const recebida = { metadata: { phone_number_id: NUM_A }, messages: [{ id: "wamid.IN", from: "5531988887777", timestamp: "1790000000", type: "text", text: { body: "oi" } }] };
    const eco = { metadata: { phone_number_id: NUM_A }, message_echoes: [{ from: "x", to: "5531988887777", id: "wamid.E", timestamp: "1790000000", type: "text", text: { body: "eco" } }] };
    const eventos = parseMetaWebhook(envelope(change(WABA_A, "messages", recebida), change(WABA_A, "history", VALOR_HISTORICO), change(WABA_A, "smb_message_echoes", eco)));
    expect(eventos.map((e) => e.kind)).toEqual(["inbound_message", "sync_payload", "echo_message"]);
  });
});

// ─── Rotas ──────────────────────────────────────────────────────────────────

let bancoDaRota = bancoComSessoes();
let sessaoDoToken: { id: string; organizationId: string; wabaId: string | null } | null = null;

function assinar(texto: string, segredo = SEGREDO): string {
  return `sha256=${createHmac("sha256", segredo).update(texto, "utf8").digest("hex")}`;
}
function entrega(url: string, corpo: unknown, assinatura?: string): NextRequest {
  const texto = JSON.stringify(corpo);
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura ?? assinar(texto) },
    body: texto,
  });
}

describe("rotas de webhook — o payload de sincronização chega só à organização dona", () => {
  const URL_UNIVERSAL = "https://crm.exemplo.com/api/v1/webhooks/meta";
  const URL_TOKEN = "https://crm.exemplo.com/api/v1/webhooks/meta/token-de-teste";
  const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

  beforeEach(() => {
    bancoDaRota = bancoComSessoes();
    sessaoDoToken = { id: "s-a", organizationId: ORG_A, wabaId: WABA_A };
  });

  it("universal: assinatura errada é 401 e nada é guardado", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_HISTORICO)), "sha256=00"));
    expect(res.status).toBe(401);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
  });

  it("universal: cada payload vai para a organização DONA do número", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const deB = { ...VALOR_CONTATOS, metadata: { phone_number_id: NUM_B } };
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_HISTORICO), change(WABA_B, "smb_app_state_sync", deB))));
    expect(res.status).toBe(200);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads!.map((l) => [l.organization_id, l.channel_session_id, l.campo])).toEqual([
      [ORG_A, "s-a", "history"],
      [ORG_B, "s-b", "smb_app_state_sync"],
    ]);
    expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["guardado", "guardado"]);
  });

  it("universal: reentrega responde 200 e não duplica", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const corpo = envelope(change(WABA_A, "history", VALOR_HISTORICO));
    await POST(entrega(URL_UNIVERSAL, corpo));
    const res = await POST(entrega(URL_UNIVERSAL, corpo));
    expect(res.status).toBe(200);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
    expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["duplicate"]);
  });

  it("universal: número sem dono e WABA divergente não gravam nada", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const semDono = { ...VALOR_HISTORICO, metadata: { phone_number_id: "100000000000009" } };
    await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", semDono), change(WABA_B, "history", VALOR_HISTORICO))));
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
  });

  it("universal: history com messages[] não chama NENHUMA ingestão", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_MIDIA_DO_HISTORICO))));
    expect(ingestMetaInbound).not.toHaveBeenCalled();
    expect(ingestMetaEcho).not.toHaveBeenCalled();
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
    expect(apenasOAvisoAoResolvedor(bancoDaRota.rpcs)).toBe(true);
  });

  it("universal: mensagem recebida e eco na mesma entrega seguem pelas ingestões de sempre", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const recebida = { metadata: { phone_number_id: NUM_A }, messages: [{ id: "wamid.IN", from: "5531988887777", timestamp: "1790000000", type: "text", text: { body: "oi" } }] };
    const eco = { metadata: { phone_number_id: NUM_A }, message_echoes: [{ from: "x", to: "5531988887777", id: "wamid.E", timestamp: "1790000000", type: "text", text: { body: "eco" } }] };
    await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "messages", recebida), change(WABA_A, "history", VALOR_HISTORICO), change(WABA_A, "smb_message_echoes", eco))));
    expect(ingestMetaInbound).toHaveBeenCalledTimes(1);
    expect(ingestMetaEcho).toHaveBeenCalledTimes(1);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(1);
  });

  it("B1: janela do payload ilegível vira 5xx na rota universal, sem gravar nada (a Meta reentrega)", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    janelaIlegivel(bancoDaRota.admin);
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_HISTORICO))));
    expect(res.status).toBe(500);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
  });

  it("falha do banco na guarda vira 5xx (a Meta reentrega)", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const original = bancoDaRota.admin.from.bind(bancoDaRota.admin);
    (bancoDaRota.admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = original(t) as unknown as Record<string, unknown>;
      if (t === "meta_sincronizacao_payloads") q.insert = () => Promise.resolve({ error: { code: "57P01", message: "x" } });
      return q;
    };
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_HISTORICO))));
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it("token: guarda na organização do TOKEN; WABA divergente é ignorada", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(entrega(URL_TOKEN, envelope(change(WABA_A, "smb_app_state_sync", VALOR_CONTATOS), change(WABA_B, "history", VALOR_HISTORICO))), ctx);
    expect(res.status).toBe(200);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads!.map((l) => [l.organization_id, l.campo])).toEqual([[ORG_A, "smb_app_state_sync"]]);
  });

  it("token: payload do número de outra organização não entra na organização do token", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const deB = { ...VALOR_HISTORICO, metadata: { phone_number_id: NUM_B } };
    await POST(entrega(URL_TOKEN, envelope(change(WABA_A, "history", deB))), ctx);
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
  });
});

// ─── Observabilidade ────────────────────────────────────────────────────────
//
// Cada recusa (400/401/404) e cada descarte com 200 no caminho da sincronização
// deixa UMA linha de log com o motivo — e nada muda no status nem no banco. O
// que não pode ir ao log: token do caminho, App Secret, assinatura, payload.

describe("observabilidade — recusas e descartes deixam rastro, sem segredo e sem payload", () => {
  const URL_UNIVERSAL = "https://crm.exemplo.com/api/v1/webhooks/meta";
  const TOKEN_DO_PATH = "token-de-teste";
  const URL_TOKEN = `https://crm.exemplo.com/api/v1/webhooks/meta/${TOKEN_DO_PATH}`;
  const ctx = { params: Promise.resolve({ token: TOKEN_DO_PATH }) } as never;

  const logsDe = (nivel: "warn" | "info") => vi.mocked(logger[nivel]).mock.calls;
  const mensagens = (nivel: "warn" | "info") => logsDe(nivel).map((c) => c[0]);
  const contexto = (nivel: "warn" | "info", trecho: string) =>
    logsDe(nivel).find((c) => String(c[0]).includes(trecho))?.[1] as Record<string, unknown> | undefined;

  /** Nada sensível em NENHUM log emitido pelo teste. */
  function semVazamento(...proibidos: string[]) {
    const tudo = JSON.stringify([...logsDe("warn"), ...logsDe("info"), ...vi.mocked(logger.error).mock.calls]);
    for (const p of [SEGREDO, TOKEN_DO_PATH, "Pablo Morales", "16505551234", ...proibidos]) {
      expect(tudo).not.toContain(p);
    }
  }

  function bruto(url: string, texto: string, assinatura?: string): NextRequest {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": assinatura ?? assinar(texto) },
      body: texto,
    });
  }

  beforeEach(() => {
    bancoDaRota = bancoComSessoes();
    sessaoDoToken = { id: "s-a", organizationId: ORG_A, wabaId: WABA_A };
  });

  it("universal: 401 continua 401 e registra o motivo", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_A, "history", VALOR_HISTORICO)), "sha256=00ff"));
    expect(res.status).toBe(401);
    expect(contexto("warn", "assinatura inválida")).toMatchObject({ rota: "universal", status: 401, assinatura_presente: true, app_secret_configurado: true });
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
    semVazamento("sha256=00ff");
  });

  it("universal: JSON inválido continua 400 e registra o motivo", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const res = await POST(bruto(URL_UNIVERSAL, "{nao-e-json"));
    expect(res.status).toBe(400);
    expect(contexto("warn", "JSON inválido")).toMatchObject({ rota: "universal", status: 400 });
    semVazamento("nao-e-json");
  });

  it("universal: WABA divergente continua 200 sem gravar, e registra o descarte", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/route");
    const res = await POST(entrega(URL_UNIVERSAL, envelope(change(WABA_B, "history", VALOR_HISTORICO))));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["waba_divergente"]);
    expect(contexto("warn", "WABA do evento difere")).toMatchObject({
      rota: "universal",
      motivo: "waba_divergente",
      campo: "history",
      waba_do_evento: WABA_B,
      waba_do_canal: WABA_A,
    });
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
    semVazamento();
  });

  it("token: 404 continua 404 e registra só o prefixo do hash do token", async () => {
    sessaoDoToken = null;
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(entrega(URL_TOKEN, envelope(change(WABA_A, "history", VALOR_HISTORICO))), ctx);
    expect(res.status).toBe(404);
    const c = contexto("warn", "token desconhecido");
    expect(c).toMatchObject({ rota: "token", status: 404 });
    expect(String(c?.token_sha256_8)).toMatch(/^[0-9a-f]{8}$/);
    semVazamento();
  });

  it("token: 401 continua 401 e registra o motivo", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(entrega(URL_TOKEN, envelope(change(WABA_A, "history", VALOR_HISTORICO)), "sha256=00ff"), ctx);
    expect(res.status).toBe(401);
    expect(contexto("warn", "assinatura inválida")).toMatchObject({ rota: "token", status: 401, organization_id: ORG_A, channel_session_id: "s-a" });
    semVazamento("sha256=00ff");
  });

  it("token: JSON inválido continua 400 e registra o motivo", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(bruto(URL_TOKEN, "{nao-e-json"), ctx);
    expect(res.status).toBe(400);
    expect(contexto("warn", "JSON inválido")).toMatchObject({ rota: "token", status: 400 });
    semVazamento("nao-e-json");
  });

  it("token: WABA divergente continua 200 sem gravar, e registra o descarte", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(entrega(URL_TOKEN, envelope(change(WABA_B, "smb_app_state_sync", VALOR_CONTATOS))), ctx);
    expect(res.status).toBe(200);
    expect(contexto("warn", "WABA do evento difere")).toMatchObject({ rota: "token", motivo: "waba_divergente", campo: "smb_app_state_sync" });
    expect(bancoDaRota.tabelas.meta_sincronizacao_payloads).toHaveLength(0);
    semVazamento();
  });

  it("token: entrega aceita registra o payload guardado com fase/pedaço/progresso", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const res = await POST(entrega(URL_TOKEN, envelope(change(WABA_A, "history", VALOR_HISTORICO))), ctx);
    expect(res.status).toBe(200);
    expect(contexto("info", "payload guardado")).toMatchObject({
      campo: "history",
      organization_id: ORG_A,
      channel_session_id: "s-a",
      fase: 0,
      chunk_order: 1,
      progresso: 55,
    });
    semVazamento();
  });

  it("parser: sincronização sem phone_number_id é descartada como antes, agora com log", () => {
    const { metadata: _sem, ...semNumero } = VALOR_HISTORICO;
    expect(parseMetaWebhook(envelope(change(WABA_A, "history", semNumero)))).toEqual([]);
    expect(contexto("warn", "sem phone_number_id")).toMatchObject({ motivo: "sem_phone_number_id", campo: "history", waba_id: WABA_A });
    semVazamento();
  });

  it("parser: objeto que não é whatsapp_business_account devolve vazio como antes, agora com log", () => {
    expect(parseMetaWebhook({ object: "page", entry: [] } as MetaWebhookEnvelope)).toEqual([]);
    expect(contexto("warn", "objeto não é whatsapp_business_account")).toMatchObject({ motivo: "objeto_inesperado", objeto: "page" });
  });

  it("guarda: no_session e duplicate mantêm o desfecho e registram o motivo", async () => {
    const banco = bancoComSessoes();
    expect(await guardarPayloadDeSincronizacao(banco.admin, { campo: "history", phoneNumberId: NUM_B, value: VALOR_HISTORICO }, { organizationId: ORG_A })).toBe("no_session");
    expect(contexto("warn", "número sem sessão")).toMatchObject({ motivo: "no_session", campo: "history", phone_number_id: NUM_B, organization_id: ORG_A });

    const e = { campo: "smb_app_state_sync" as const, phoneNumberId: NUM_A, value: VALOR_CONTATOS };
    expect(await guardarPayloadDeSincronizacao(banco.admin, e, { organizationId: ORG_A })).toBe("guardado");
    expect(await guardarPayloadDeSincronizacao(banco.admin, structuredClone(e), { organizationId: ORG_A })).toBe("duplicate");
    expect(mensagens("info").filter((m) => String(m).includes("payload guardado"))).toHaveLength(1);
    const dup = contexto("info", "payload repetido");
    expect(dup).toMatchObject({ motivo: "duplicate", campo: "smb_app_state_sync" });
    expect(String(dup?.payload_hash_12)).toMatch(/^[0-9a-f]{12}$/);
    semVazamento();
  });
});
