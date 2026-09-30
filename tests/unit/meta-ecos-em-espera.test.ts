/**
 * Ecos do app em espera (migration 0496) — a mídia histórica que a Meta entrega
 * por `smb_message_echoes` não vira mensagem nova.
 *
 * O que cada bloco tranca:
 *   a) eco AO VIVO: o caminho de sempre, com todos os efeitos;
 *   b) eco HISTÓRICO (timestamp anterior ao onboarding): só a quarentena — zero
 *      contato, conversa, mensagem, pausa, carimbo ou auditoria;
 *   c/d) o history chega DEPOIS ou ANTES do eco: a correlação por wamid decide;
 *   e) RETRY de eco ao vivo anterior ao onboarding: promovido quando o history
 *      termina sem o wamid, sem pausar a IA por resposta antiga;
 *   f) DOIS onboardings: as quarentenas não se enxergam;
 *   g) CORRIDA entre resolvedores: uma promoção só;
 *   h) só `media_placeholder` com `from_me` casa;
 *   i) mensagem RECEBIDA segue a ingestão de sempre;
 *   j) `field=history` com `messages[]`/`message_echoes[]` nunca é ingerido;
 *   k) pedido de history `falhou` DENTRO do prazo de pedir não é fim: o eco
 *      espera o novo pedido, e o history dele o classifica;
 *   A1) erro ao LER o onboarding não é "canal sem onboarding": lança, nada é escrito;
 *   B1) pedaço de history cuja janela não foi lida não é guardado sem janela;
 *   B2/B3) a identidade de pedaço e de eco inclui a janela: O1 e O2 não se misturam;
 *   B4) o fim do history não é decidido por um recorte de `max_rows`.
 *
 * E os invariantes: eco suspeito nunca cria mensagem/contato/conversa; o resolvedor
 * nunca transforma placeholder em mensagem; um wamid histórico não nasce por dois
 * caminhos. A correlação aqui é uma réplica em JS da função SQL — a função real
 * é medida em `tests/invariants/ecos-em-espera.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  PRAZO_DO_SILENCIO_MS: 60 * 60 * 1000,
  pausarIaPorAtendimentoManual: vi.fn(async () => true),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: vi.fn(async () => false),
  registrarMensagemIgnorada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn(async () => null) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn(async () => ({ token: "tok-teste" })) }));

import { audit } from "@/lib/audit";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import {
  EVENTO_CHUNK_GUARDADO,
  FOLGA_DO_ONBOARDING_MS,
  classificarEco,
  contarEcosEmEspera,
} from "@/lib/channels/meta/ecos-em-espera";
import { ingestMetaEcho } from "@/lib/channels/meta/ingest-eco";
import { HISTORICO_PARADO_MS, historicoTerminou, resolverEcosEmEspera } from "@/lib/channels/meta/resolver-ecos-em-espera";
import {
  PRAZO_DA_SINCRONIZACAO_MS,
  guardarPayloadDeSincronizacao,
  solicitarSincronizacaoDoApp,
} from "@/lib/channels/meta/sincronizacao";
import { parseMetaWebhook, type EchoMessageEvent, type MetaWebhookEnvelope } from "@/lib/channels/meta/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

const ORG = "org-a";
const OUTRA_ORG = "org-b";
const SESSAO = "s-a";
const NUM = "100000000000001";
const WABA = "200000000000001";
const CLIENTE = "5531988887777";
const O1 = "2026-09-27T02:58:54.984Z";
const O2 = "2026-10-05T10:00:00.000Z";
const ANTES = new Date("2026-09-20T15:00:00.000Z"); // mídia de dias antes do onboarding
const DEPOIS = new Date("2026-09-27T03:10:00.000Z"); // resposta pelo celular depois do onboarding
const AGORA = new Date("2026-09-27T03:20:00.000Z");

// ─── Banco em memória: filtros, unicidade e as RPCs que o caminho usa ───────

type Linha = Record<string, unknown>;
const UNICOS: Record<string, string[]> = {
  messages: ["organization_id", "external_id"],
  // As chaves da 0496: a JANELA faz parte da identidade (e `null === null`, como o
  // `nulls not distinct` do payload).
  meta_ecos_em_espera: ["organization_id", "channel_session_id", "onboarding_em", "external_id"],
  meta_sincronizacao_payloads: ["channel_session_id", "onboarding_em", "campo", "payload_hash"],
  meta_sincronizacoes: ["channel_session_id", "onboarding_em", "tipo"],
};
const PADROES: Record<string, Linha> = {
  meta_ecos_em_espera: { estado: "aguardando", motivo: null, decidido_em: null },
  meta_sincronizacao_payloads: { recebido_em: AGORA.toISOString() },
  meta_sincronizacoes: { status: "pendente", request_id: null, solicitada_em: null, recebido_em: null, erro: null },
};

/** O `max_rows` do PostgREST (supabase/config.toml): nenhuma resposta passa disto. */
const MAX_ROWS = 1000;

interface Banco {
  admin: SupabaseClient;
  t: Record<string, Linha[]>;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
  /** Falhas injetáveis: `onboarding` faz a leitura de `channel_sessions.meta_onboarding_em` errar. */
  falhas: { onboarding: boolean };
}

function comparar(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

function banco(inicial: Partial<Record<string, Linha[]>> = {}): Banco {
  const t: Record<string, Linha[]> = {
    channel_sessions: [{ id: SESSAO, organization_id: ORG, meta_phone_number_id: NUM, meta_onboarding_em: O1, archived_at: null }],
    messages: [],
    contacts: [],
    conversations: [],
    event_log: [],
    meta_ecos_em_espera: [],
    meta_sincronizacao_payloads: [],
    meta_sincronizacoes: [],
    ...(inicial as Record<string, Linha[]>),
  };
  const rpcs: Banco["rpcs"] = [];
  const falhas: Banco["falhas"] = { onboarding: false };
  let seq = 0;

  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let ignorarDuplicadas = false;
    let patch: Linha = {};
    let novas: Linha[] = [];
    const ordens: Array<{ coluna: string; asc: boolean }> = [];
    let limite: number | null = null;
    let colunas: string | undefined;
    let devolver = false;
    const exec = () => {
      const linhas = (t[tabela] ??= []);
      const casa = (l: Linha) => filtros.every((f) => f(l));
      if (op === "select") {
        if (falhas.onboarding && tabela === "channel_sessions" && colunas === "meta_onboarding_em") {
          return { data: null, error: { code: "57P01", message: "conexão caiu" } };
        }
        const r = linhas.filter(casa).map((l) => ({ ...l }));
        if (ordens.length > 0) {
          r.sort((a, b) => {
            for (const o of ordens) {
              const c = comparar(a[o.coluna], b[o.coluna]);
              if (c !== 0) return o.asc ? c : -c;
            }
            return 0;
          });
        }
        return { data: r.slice(0, Math.min(limite ?? Infinity, MAX_ROWS)), error: null };
      }
      if (op === "update") {
        const alvo = linhas.filter(casa);
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ ...l })), error: null };
      }
      const criadas: Linha[] = [];
      for (const nova of novas) {
        const chave = UNICOS[tabela];
        if (chave && linhas.some((l) => chave.every((c) => l[c] === nova[c]))) {
          if (ignorarDuplicadas) continue;
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const linha = { id: `${tabela}-${++seq}`, ...(PADROES[tabela] ?? {}), ...nova };
        linhas.push(linha);
        criadas.push({ ...linha });
      }
      return { data: devolver ? criadas : null, error: null };
    };
    const q: Record<string, unknown> = {
      select: (c?: string) => ((devolver = true), (colunas = c), q),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      lt: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) < v), q),
      gt: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) > v), q),
      gte: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) >= v), q),
      like: (c: string, p: string) => {
        const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        filtros.push((l) => typeof l[c] === "string" && re.test(l[c] as string));
        return q;
      },
      order: (c: string, o?: { ascending?: boolean }) => (ordens.push({ coluna: c, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limite = n), q),
      update: (p: Linha) => ((op = "update"), (patch = p), q),
      insert: (r: Linha | Linha[]) => ((op = "insert"), (novas = Array.isArray(r) ? r : [r]), q),
      upsert: (r: Linha | Linha[], o?: { ignoreDuplicates?: boolean }) => (
        (op = "insert"), (novas = Array.isArray(r) ? r : [r]), (ignorarDuplicadas = o?.ignoreDuplicates === true), q
      ),
      maybeSingle: async () => {
        const r = exec();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      then: (ok: (r: unknown) => void, erro?: (e: unknown) => void) => Promise.resolve(exec()).then(ok, erro),
    };
    return q;
  };

  const rpc = async (nome: string, args: Record<string, unknown>) => {
    rpcs.push({ nome, args });
    if (nome === "fn_upsert_wa_contact") {
      let c = t.contacts!.find((x) => x.organization_id === args.p_org && x.chat_id === args.p_chat_id);
      if (!c) t.contacts!.push((c = { id: `contato-${++seq}`, organization_id: args.p_org, chat_id: args.p_chat_id }));
      return { data: c.id, error: null };
    }
    if (nome === "fn_upsert_wa_conversation") {
      let c = t.conversations!.find((x) => x.organization_id === args.p_org && x.contact_id === args.p_contact);
      if (!c) {
        t.conversations!.push(
          (c = { id: `conversa-${++seq}`, organization_id: args.p_org, contact_id: args.p_contact, last_message_at: null }),
        );
      }
      return { data: c.id, error: null };
    }
    if (nome === "emit_event") {
      t.event_log!.push({ organization_id: args.p_organization_id, event_type: args.p_event_type, payload: args.p_payload });
      return { data: null, error: null };
    }
    if (nome === "fn_meta_ecos_correlacionar") return { data: correlacionar(t, args), error: null };
    return { data: null, error: null };
  };

  return { admin: { from, rpc } as unknown as SupabaseClient, t, rpcs, falhas };
}

/** Réplica da `fn_meta_ecos_correlacionar`: placeholder `from_me` do history DA JANELA. */
function correlacionar(t: Record<string, Linha[]>, a: Record<string, unknown>): Array<{ wamid: string }> {
  const ids = new Set<string>();
  for (const p of t.meta_sincronizacao_payloads ?? []) {
    if (p.organization_id !== a.p_org || p.channel_session_id !== a.p_sessao || p.onboarding_em !== a.p_onboarding) continue;
    if (p.campo !== "history") continue;
    for (const h of ((p.payload as Linha).history as Linha[] | undefined) ?? []) {
      for (const th of (h.threads as Linha[] | undefined) ?? []) {
        for (const m of (th.messages as Linha[] | undefined) ?? []) {
          const ctx = (m.history_context ?? {}) as Linha;
          if (m.type === "media_placeholder" && ctx.from_me === true) ids.add(String(m.id));
        }
      }
    }
  }
  const saida: Array<{ wamid: string }> = [];
  for (const q of t.meta_ecos_em_espera ?? []) {
    if (q.organization_id !== a.p_org || q.channel_session_id !== a.p_sessao || q.onboarding_em !== a.p_onboarding) continue;
    if (q.estado !== "aguardando" || !ids.has(String(q.external_id))) continue;
    Object.assign(q, { estado: "historico", motivo: "wamid_no_historico", decidido_em: AGORA.toISOString() });
    saida.push({ wamid: String(q.external_id) });
  }
  return saida;
}

// ─── Fábricas ───────────────────────────────────────────────────────────────

function eco(wamid: string, sentAt: Date, extra: Partial<EchoMessageEvent> = {}): EchoMessageEvent {
  const bruto = {
    from: "5531900000000",
    to: CLIENTE,
    id: wamid,
    timestamp: String(Math.floor(sentAt.getTime() / 1000)),
    type: "image",
    image: { id: `midia-${wamid}`, mime_type: "image/jpeg" },
  };
  return {
    kind: "echo_message",
    wabaId: WABA,
    phoneNumberId: NUM,
    externalId: wamid,
    to: CLIENTE,
    sentAt,
    type: "image",
    text: null,
    media: { id: `midia-${wamid}`, url: null, mime: "image/jpeg", voice: false },
    bruto,
    ...extra,
  };
}

/** Um pedaço de history com as entradas dadas (id, tipo, from_me). */
function pedaco(entradas: Array<{ id: string; type: string; fromMe: boolean }>, meta = { phase: 1, chunk_order: 1, progress: 7 }) {
  return {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "5531900000000", phone_number_id: NUM },
    history: [
      {
        metadata: meta,
        threads: [
          {
            id: CLIENTE,
            messages: entradas.map((x) => ({
              from: x.fromMe ? "5531900000000" : CLIENTE,
              id: x.id,
              timestamp: "1790000000",
              type: x.type,
              history_context: x.fromMe ? { status: "delivered", from_me: true } : { status: "read" },
            })),
          },
        ],
      },
    ],
  };
}

const guardar = (b: Banco, value: Record<string, unknown>) =>
  guardarPayloadDeSincronizacao(b.admin, { campo: "history", phoneNumberId: NUM, value }, { organizationId: ORG });

const janela = (onboardingEm = O1) => ({ organizationId: ORG, channelSessionId: SESSAO, onboardingEm });

const pedidoSolicitado = (onboardingEm = O1): Linha => ({
  organization_id: ORG,
  channel_session_id: SESSAO,
  onboarding_em: onboardingEm,
  tipo: "historico",
  status: "solicitada",
});

/** O history DA JANELA terminou: a fase 2 chegou a 100. */
const historicoCompleto = (b: Banco) => guardar(b, pedaco([], { phase: 2, chunk_order: 9, progress: 100 }));

/** Sem efeito de mensagem: nenhuma escrita em messages/contacts/conversations e nenhuma RPC de upsert. */
function semEfeitoDeMensagem(b: Banco) {
  expect(b.t.messages).toHaveLength(0);
  expect(b.t.contacts).toHaveLength(0);
  expect(b.t.conversations).toHaveLength(0);
  expect(b.rpcs.filter((r) => r.nome.startsWith("fn_upsert"))).toHaveLength(0);
  expect(b.t.event_log!.filter((e) => e.event_type !== EVENTO_CHUNK_GUARDADO)).toHaveLength(0);
  expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  expect(marcarConversaComMensagem).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "message.sent" }));
}

beforeEach(() => vi.clearAllMocks());

// ─── A porta de suspeita ────────────────────────────────────────────────────

describe("classificarEco — a porta de suspeita, pura", () => {
  it("canal sem onboarding é sempre ao vivo", () => {
    expect(classificarEco(ANTES, null)).toBe("ao_vivo");
  });
  it("anterior ao onboarding (fora da folga) é suspeito", () => {
    expect(classificarEco(ANTES, O1)).toBe("suspeito");
    expect(classificarEco(new Date(Date.parse(O1) - FOLGA_DO_ONBOARDING_MS - 1000), O1)).toBe("suspeito");
  });
  it("dentro da folga de relógio, ou depois do onboarding, é ao vivo", () => {
    expect(classificarEco(new Date(Date.parse(O1) - FOLGA_DO_ONBOARDING_MS + 1000), O1)).toBe("ao_vivo");
    expect(classificarEco(DEPOIS, O1)).toBe("ao_vivo");
  });
});

// ─── a) eco ao vivo ─────────────────────────────────────────────────────────

describe("a) eco AO VIVO — o caminho de sempre", () => {
  it("depois do onboarding: contato, conversa, mensagem, carimbo, pausa e auditoria; nada na quarentena", async () => {
    const b = banco();
    const r = await ingestMetaEcho(b.admin, eco("wamid.VIVO", DEPOIS), { organizationId: ORG }, { agora: AGORA });

    expect(r.status).toBe("ingested");
    expect(b.t.messages).toHaveLength(1);
    expect(b.t.messages![0]).toMatchObject({ direction: "outbound", sent_via: "external_device", external_id: "wamid.VIVO" });
    expect(b.t.contacts).toHaveLength(1);
    expect(b.t.conversations).toHaveLength(1);
    expect(marcarConversaComMensagem).toHaveBeenCalledTimes(1);
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.sent" }));
    expect(b.t.event_log!.map((e) => e.event_type)).toEqual(["media.persist_requested"]);
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
  });

  it("canal sem onboarding (Cloud API dedicada): até eco antigo segue ao vivo, como antes da 0496", async () => {
    const b = banco({ channel_sessions: [{ id: SESSAO, organization_id: ORG, meta_phone_number_id: NUM, meta_onboarding_em: null, archived_at: null }] });
    const r = await ingestMetaEcho(b.admin, eco("wamid.SEM_ONB", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(r.status).toBe("ingested");
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
  });
});

// ─── b) eco histórico — o invariante 1 ──────────────────────────────────────

describe("b) eco HISTÓRICO — só a quarentena (invariante: suspeito nunca cria mensagem/contato/conversa)", () => {
  it.each([
    ["imagem", {}],
    ["áudio", { type: "audio", media: { id: "m-a", url: null, mime: "audio/ogg", voice: true } }],
    ["texto", { type: "text", text: "respondi pelo celular", media: null }],
    ["contato", { type: "contact", text: "Fulano", media: null }],
  ] as const)("%s anterior ao onboarding vai para a quarentena, bruto, e nada mais", async (_n, extra) => {
    const b = banco();
    const r = await ingestMetaEcho(b.admin, eco("wamid.HIST", ANTES, extra as Partial<EchoMessageEvent>), { organizationId: ORG }, { agora: AGORA });

    expect(r).toEqual({ status: "em_espera" });
    semEfeitoDeMensagem(b);
    expect(b.t.meta_ecos_em_espera).toHaveLength(1);
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({
      organization_id: ORG,
      channel_session_id: SESSAO,
      onboarding_em: O1,
      external_id: "wamid.HIST",
      estado: "aguardando",
      bruto: expect.objectContaining({ id: "wamid.HIST", to: CLIENTE }),
    });
    // O eco não emite evento: só o pedaço de history guardado o faz.
    expect(b.t.event_log).toHaveLength(0);
  });

  it("reentrega do mesmo eco suspeito: uma linha só na quarentena, nenhum efeito", async () => {
    const b = banco();
    await ingestMetaEcho(b.admin, eco("wamid.R", ANTES), { organizationId: ORG }, { agora: AGORA });
    const segunda = await ingestMetaEcho(b.admin, eco("wamid.R", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(segunda).toEqual({ status: "em_espera" });
    expect(b.t.meta_ecos_em_espera).toHaveLength(1);
    semEfeitoDeMensagem(b);
  });

  it("wamid que JÁ é mensagem é duplicate e não entra na quarentena", async () => {
    const b = banco({ messages: [{ id: "m0", organization_id: ORG, external_id: "wamid.JA" }] });
    const r = await ingestMetaEcho(b.admin, eco("wamid.JA", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(r).toEqual({ status: "duplicate" });
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
  });

  it("número de outra organização: no_session antes de qualquer leitura de janela", async () => {
    const b = banco();
    const r = await ingestMetaEcho(b.admin, eco("wamid.X", ANTES), { organizationId: OUTRA_ORG }, { agora: AGORA });
    expect(r).toEqual({ status: "no_session" });
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
  });
});

// ─── c/d/h) a correlação por wamid ──────────────────────────────────────────

describe("c) history chega DEPOIS do eco (o caso medido)", () => {
  it("o eco espera; o pedaço com o placeholder `from_me` do mesmo wamid o classifica como histórico — sem mensagem", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.C", ANTES), { organizationId: ORG }, { agora: AGORA });

    const antes = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(antes).toMatchObject({ historico: 0, aguardando: 1, promovidos: 0 });

    await guardar(b, pedaco([{ id: "wamid.C", type: "media_placeholder", fromMe: true }]));
    expect(b.t.event_log!.map((e) => e.event_type)).toEqual([EVENTO_CHUNK_GUARDADO]);

    const depois = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(depois).toMatchObject({ historico: 1, promovidos: 0 });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "historico", motivo: "wamid_no_historico" });
    semEfeitoDeMensagem(b);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "meta.eco_historico_classificado", organizationId: ORG }));
  });
});

describe("d) history chega ANTES do eco", () => {
  // Nenhum pedaço novo acorda o resolvedor aqui: quem roda é o cron (5 min).
  it("o eco entra na quarentena mesmo assim, e a primeira resolução já o classifica", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await guardar(b, pedaco([{ id: "wamid.D", type: "media_placeholder", fromMe: true }]));
    const r = await ingestMetaEcho(b.admin, eco("wamid.D", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(r).toEqual({ status: "em_espera" });

    expect(await resolverEcosEmEspera(b.admin, janela(), AGORA)).toMatchObject({ historico: 1 });
    semEfeitoDeMensagem(b);
  });
});

describe("h) só `media_placeholder` com `from_me` casa", () => {
  it("placeholder do CLIENTE, ou texto com o mesmo id, não classificam o eco", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.H1", ANTES), { organizationId: ORG }, { agora: AGORA });
    await ingestMetaEcho(b.admin, eco("wamid.H2", ANTES), { organizationId: ORG }, { agora: AGORA });
    await guardar(
      b,
      pedaco([
        { id: "wamid.H1", type: "media_placeholder", fromMe: false },
        { id: "wamid.H2", type: "text", fromMe: true },
      ]),
    );
    const r = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(r).toMatchObject({ historico: 0, aguardando: 2 });
    expect(b.t.meta_ecos_em_espera!.map((q) => q.estado)).toEqual(["aguardando", "aguardando"]);
  });
});

// ─── e) retry / eco tardio ──────────────────────────────────────────────────

describe("e) RETRY de eco ao vivo anterior ao onboarding", () => {
  it("history completo sem o wamid: promovido pelo caminho ao vivo, SEM pausar a IA por resposta antiga", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.RETRY", ANTES), { organizationId: ORG }, { agora: AGORA });
    await historicoCompleto(b);

    const r = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(r).toMatchObject({ historico: 0, promovidos: 1, fim: { terminou: true, motivo: "historico_completo" } });
    expect(b.t.messages).toHaveLength(1);
    expect(b.t.messages![0]).toMatchObject({ external_id: "wamid.RETRY", sent_via: "external_device", sent_at: ANTES.toISOString() });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "promovido", motivo: "historico_completo" });
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "meta.eco_tardio_promovido" }));
  });

  it("promovido não carimba a conversa com mensagem mais velha que a última dela", async () => {
    const b = banco({
      meta_sincronizacoes: [pedidoSolicitado()],
      contacts: [{ id: "c1", organization_id: ORG, chat_id: CLIENTE }],
      conversations: [{ id: "cv1", organization_id: ORG, contact_id: "c1", last_message_at: "2026-09-26T20:00:00.000Z" }],
    });
    await ingestMetaEcho(b.admin, eco("wamid.VELHO", ANTES), { organizationId: ORG }, { agora: AGORA });
    await historicoCompleto(b);
    await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(b.t.messages).toHaveLength(1);
    expect(marcarConversaComMensagem).not.toHaveBeenCalled();
  });

  it("eco tardio RECENTE (dentro do prazo do silêncio) ainda pausa", async () => {
    const recente = new Date(AGORA.getTime() - 10 * 60 * 1000);
    const b = banco({
      channel_sessions: [{ id: SESSAO, organization_id: ORG, meta_phone_number_id: NUM, meta_onboarding_em: AGORA.toISOString(), archived_at: null }],
      meta_sincronizacoes: [pedidoSolicitado(AGORA.toISOString())],
    });
    await ingestMetaEcho(b.admin, eco("wamid.REC", recente), { organizationId: ORG }, { agora: AGORA });
    await historicoCompleto(b);
    await resolverEcosEmEspera(b.admin, janela(AGORA.toISOString()), AGORA);
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalledTimes(1);
  });

  it("o wamid virou mensagem enquanto esperava: duplicado, sem segunda linha", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.DUP", ANTES), { organizationId: ORG }, { agora: AGORA });
    b.t.messages!.push({ id: "m-x", organization_id: ORG, external_id: "wamid.DUP" });
    await historicoCompleto(b);
    const r = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(r).toMatchObject({ duplicados: 1, promovidos: 0 });
    expect(b.t.messages).toHaveLength(1);
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "duplicado" });
  });

  it("history ainda em curso: nada é promovido", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.ESPERA", ANTES), { organizationId: ORG }, { agora: AGORA });
    await guardar(b, pedaco([], { phase: 1, chunk_order: 3, progress: 21 }));
    const r = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(r).toMatchObject({ promovidos: 0, aguardando: 1, fim: { terminou: false, motivo: "historico_em_andamento" } });
    expect(b.t.messages).toHaveLength(0);
  });

  it("promoção largada no meio (processo caiu depois do claim) é retomada, e o duplicate da retomada conta como promoção", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.LARG", ANTES), { organizationId: ORG }, { agora: AGORA });
    Object.assign(b.t.meta_ecos_em_espera![0]!, {
      estado: "promovido",
      motivo: "promovendo:historico_completo",
      decidido_em: new Date(AGORA.getTime() - 10 * 60 * 1000).toISOString(),
    });
    b.t.messages!.push({ id: "m-l", organization_id: ORG, external_id: "wamid.LARG" }); // a tentativa anterior gravou
    const r = await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(r).toMatchObject({ promovidos: 1, duplicados: 0 });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "promovido", motivo: "historico_completo" });
  });
});

describe("historicoTerminou — quando o eco em espera pode ser decidido", () => {
  const b0 = () => banco();
  it.each(["recusada", "expirada"])("pedido %s: terminou (estado final)", async (status) => {
    const b = b0();
    b.t.meta_sincronizacoes!.push({ ...pedidoSolicitado(), status });
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toEqual({ terminou: true, motivo: `historico_${status}` });
  });
  it("pedido falhou DENTRO do prazo de pedir: NÃO terminou — um novo pedido ainda pode trazer o history", async () => {
    const b = b0();
    b.t.meta_sincronizacoes!.push({ ...pedidoSolicitado(), status: "falhou" });
    const noLimite = new Date(Date.parse(O1) + PRAZO_DA_SINCRONIZACAO_MS);
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toEqual({ terminou: false, motivo: "aguardando_primeiro_pedaco" });
    expect(await historicoTerminou(b.admin, janela(), noLimite)).toMatchObject({ terminou: false });
  });
  it("pedido falhou DEPOIS do prazo de pedir: terminou — ninguém mais pode pedir", async () => {
    const b = b0();
    b.t.meta_sincronizacoes!.push({ ...pedidoSolicitado(), status: "falhou" });
    const depoisDoPrazo = new Date(Date.parse(O1) + PRAZO_DA_SINCRONIZACAO_MS + 1);
    expect(await historicoTerminou(b.admin, janela(), depoisDoPrazo)).toEqual({ terminou: true, motivo: "historico_falhou" });
  });
  it("pedido falhou dentro do prazo, mas o history chegou inteiro: os pedaços decidem", async () => {
    const b = banco({ meta_sincronizacoes: [{ ...pedidoSolicitado(), status: "falhou" }] });
    await historicoCompleto(b);
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toEqual({ terminou: true, motivo: "historico_completo" });
  });
  it("novo pedido em curso (`solicitando`) sem pedaço: NÃO terminou", async () => {
    const b = b0();
    b.t.meta_sincronizacoes!.push({ ...pedidoSolicitado(), status: "solicitando" });
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toEqual({ terminou: false, motivo: "aguardando_primeiro_pedaco" });
  });
  it("fase 2 com progresso 100: terminou", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await historicoCompleto(b);
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toEqual({ terminou: true, motivo: "historico_completo" });
  });
  it("fase 1 com progresso 100 NÃO é fim; nem fase 2 abaixo de 100", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await guardar(b, pedaco([], { phase: 1, chunk_order: 15, progress: 100 }));
    await guardar(b, pedaco([], { phase: 2, chunk_order: 1, progress: 40 }));
    expect(await historicoTerminou(b.admin, janela(), AGORA)).toMatchObject({ terminou: false });
  });
  it("sem pedido e sem pedaço: nenhum critério novo — espera até o teto", async () => {
    const depoisDoPrazoDePedir = new Date(Date.parse(O1) + 25 * 60 * 60 * 1000);
    expect(await historicoTerminou(b0().admin, janela(), depoisDoPrazoDePedir)).toEqual({
      terminou: false,
      motivo: "aguardando_primeiro_pedaco",
    });
  });
  it("pedido e parado há mais de 6h: terminou", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await guardar(b, pedaco([], { phase: 1, chunk_order: 1, progress: 7 }));
    b.t.meta_sincronizacao_payloads![0]!.recebido_em = AGORA.toISOString();
    const depois = new Date(AGORA.getTime() + HISTORICO_PARADO_MS + 1000);
    expect(await historicoTerminou(b.admin, janela(), depois)).toEqual({ terminou: true, motivo: "historico_parado" });
  });
  it("teto de 7 dias do onboarding: terminou", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    expect(await historicoTerminou(b.admin, janela(), new Date(Date.parse(O1) + 8 * 24 * 60 * 60 * 1000))).toEqual({
      terminou: true,
      motivo: "teto_da_espera",
    });
  });
});

// ─── k) history falhou + novo pedido ────────────────────────────────────────

describe("k) pedido de history FALHOU e um novo pedido é feito dentro das 24h", () => {
  /** O canal de verdade para o pedido: coexistência, com número e onboarding O1. */
  const canalDeCoexistencia = () => [
    {
      id: SESSAO,
      organization_id: ORG,
      provider: "meta_cloud",
      meta_modo: "coexistencia",
      meta_phone_number_id: NUM,
      meta_onboarding_em: O1,
      archived_at: null,
    },
  ];
  const minutos = (n: number) => new Date(Date.parse(O1) + n * 60_000);

  /** A Meta de mentira: `history` responde conforme `historicoOk`; contatos sempre aceita. */
  let historicoOk = false;
  const pedidosNaMeta: string[] = [];
  beforeEach(() => {
    historicoOk = false;
    pedidosNaMeta.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const tipo = String((JSON.parse(init.body) as { sync_type: string }).sync_type);
        pedidosNaMeta.push(tipo);
        if (tipo === "history" && !historicoOk) {
          return new Response(JSON.stringify({ error: { message: "boom", code: 1 } }), { status: 500 });
        }
        return new Response(JSON.stringify({ request_id: `req-${tipo}-${pedidosNaMeta.length}` }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const statusDoHistorico = (b: Banco) => b.t.meta_sincronizacoes!.find((l) => l.tipo === "historico")?.status;

  /** Passos 1–5: O1 pede, o history falha, o eco histórico entra e o resolvedor NÃO o promove. */
  async function falhouComEcoEmEspera() {
    const b = banco({ channel_sessions: canalDeCoexistencia() });

    // 1–2. O1 solicita history, e o pedido termina em `falhou`.
    const primeiro = await solicitarSincronizacaoDoApp(b.admin, { organizationId: ORG, agora: minutos(1) });
    expect(primeiro).toMatchObject({ ok: true, contatos: "solicitada", historico: "falhou" });
    expect(statusDoHistorico(b)).toBe("falhou");

    // 3. Eco histórico entra em quarentena.
    const r = await ingestMetaEcho(b.admin, eco("wamid.HIST", ANTES), { organizationId: ORG }, { agora: minutos(2) });
    expect(r.status).toBe("em_espera");

    // 4–5. Resolvedor roda antes do novo pedido: o eco continua `aguardando`.
    const antes = await resolverEcosEmEspera(b.admin, janela(), minutos(30));
    expect(antes).toMatchObject({ historico: 0, promovidos: 0, aguardando: 1, fim: { terminou: false } });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ external_id: "wamid.HIST", estado: "aguardando" });
    semEfeitoDeMensagem(b);
    return b;
  }

  it("novo pedido aceito: o history traz o wamid como placeholder from_me e o eco vira `historico`, sem mensagem", async () => {
    const b = await falhouComEcoEmEspera();

    // 6. Novo pedido O1, dentro das 24h — só o history é pedido de novo.
    historicoOk = true;
    const segundo = await solicitarSincronizacaoDoApp(b.admin, { organizationId: ORG, agora: minutos(120) });
    expect(segundo).toMatchObject({ ok: true, contatos: "ja_solicitada", historico: "solicitada" });
    expect(pedidosNaMeta).toEqual(["smb_app_state_sync", "history", "history"]);

    // Entre o pedido e o primeiro pedaço, o eco segue esperando.
    expect(await resolverEcosEmEspera(b.admin, janela(), minutos(125))).toMatchObject({ promovidos: 0, aguardando: 1 });

    // 7. O history chega com o MESMO wamid como media_placeholder/from_me.
    await guardar(b, pedaco([{ id: "wamid.HIST", type: "media_placeholder", fromMe: true }]));
    const depois = await resolverEcosEmEspera(b.admin, janela(), minutos(130));

    // 8. O eco passa para `historico`.
    expect(depois).toMatchObject({ historico: 1, promovidos: 0, duplicados: 0 });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "historico", motivo: "wamid_no_historico" });

    // 9. Nenhuma message/contact/conversation criada pelo eco.
    semEfeitoDeMensagem(b);
  });

  it("novo pedido falha DE NOVO: o eco segue `aguardando` enquanto ainda dá para pedir, e só é promovido depois do prazo", async () => {
    const b = await falhouComEcoEmEspera();

    // O segundo pedido também falha.
    const segundo = await solicitarSincronizacaoDoApp(b.admin, { organizationId: ORG, agora: minutos(120) });
    expect(segundo).toMatchObject({ ok: true, contatos: "ja_solicitada", historico: "falhou" });
    expect(pedidosNaMeta).toEqual(["smb_app_state_sync", "history", "history"]);

    // Ainda dentro das 24h: continua esperando, sem efeito nenhum.
    const dentro = await resolverEcosEmEspera(b.admin, janela(), minutos(23 * 60));
    expect(dentro).toMatchObject({ promovidos: 0, aguardando: 1, fim: { terminou: false } });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "aguardando" });
    semEfeitoDeMensagem(b);

    // Passado o prazo de pedir, `falhou` é final: o eco não correlacionado é promovido como tardio.
    const depoisDoPrazo = new Date(Date.parse(O1) + PRAZO_DA_SINCRONIZACAO_MS + 60_000);
    const fim = await resolverEcosEmEspera(b.admin, janela(), depoisDoPrazo);
    expect(fim).toMatchObject({ promovidos: 1, fim: { terminou: true, motivo: "historico_falhou" } });
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "promovido", motivo: "historico_falhou" });
    expect(b.t.messages).toHaveLength(1);
    // Tardio: resposta de dias atrás não pausa a IA.
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("depois do prazo, um novo pedido não chama a Meta: `falhou` vira `expirada`, e o eco é promovido por ela", async () => {
    const b = await falhouComEcoEmEspera();
    const depoisDoPrazo = new Date(Date.parse(O1) + PRAZO_DA_SINCRONIZACAO_MS + 60_000);

    const tarde = await solicitarSincronizacaoDoApp(b.admin, { organizationId: ORG, agora: depoisDoPrazo });
    expect(tarde).toMatchObject({ ok: true, historico: "expirada" });
    expect(pedidosNaMeta).toEqual(["smb_app_state_sync", "history"]);

    const fim = await resolverEcosEmEspera(b.admin, janela(), depoisDoPrazo);
    expect(fim).toMatchObject({ promovidos: 1, fim: { terminou: true, motivo: "historico_expirada" } });
  });
});

// ─── A1) erro ao ler o onboarding ≠ canal sem onboarding ───────────────────

describe("A1) a leitura do onboarding: ausência real segue ao vivo; ERRO falha fechado", () => {
  it("onboarding válido: eco antigo vai para a quarentena, eco novo segue ao vivo", async () => {
    const b = banco();
    expect((await ingestMetaEcho(b.admin, eco("wamid.A1_ANTIGO", ANTES), { organizationId: ORG }, { agora: AGORA })).status).toBe("em_espera");
    expect((await ingestMetaEcho(b.admin, eco("wamid.A1_NOVO", DEPOIS), { organizationId: ORG }, { agora: AGORA })).status).toBe("ingested");
    expect(b.t.meta_ecos_em_espera!.map((q) => q.external_id)).toEqual(["wamid.A1_ANTIGO"]);
    expect(b.t.messages!.map((m) => m.external_id)).toEqual(["wamid.A1_NOVO"]);
  });

  it("ausência REAL (leitura ok, coluna vazia): o canal não tem janela, e o eco segue ao vivo", async () => {
    const b = banco({ channel_sessions: [{ id: SESSAO, organization_id: ORG, meta_phone_number_id: NUM, meta_onboarding_em: null, archived_at: null }] });
    const r = await ingestMetaEcho(b.admin, eco("wamid.A1_SEM", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(r.status).toBe("ingested");
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
  });

  it("leitura FALHA: lança (a rota responde 5xx e a Meta reentrega) — nenhum efeito, nem na quarentena", async () => {
    const b = banco();
    b.falhas.onboarding = true;
    for (const [wamid, quando] of [["wamid.A1_X_ANTIGO", ANTES], ["wamid.A1_X_NOVO", DEPOIS]] as const) {
      await expect(ingestMetaEcho(b.admin, eco(wamid, quando), { organizationId: ORG }, { agora: AGORA })).rejects.toThrow(
        "channel_sessions (onboarding)",
      );
    }
    semEfeitoDeMensagem(b);
    expect(b.t.event_log).toHaveLength(0);
    expect(b.t.meta_ecos_em_espera).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();

    // A reentrega, com o banco de volta, segue o caminho certo.
    b.falhas.onboarding = false;
    expect((await ingestMetaEcho(b.admin, eco("wamid.A1_X_ANTIGO", ANTES), { organizationId: ORG }, { agora: AGORA })).status).toBe("em_espera");
    semEfeitoDeMensagem(b);
  });
});

// ─── B1) pedaço de history sem janela lida ──────────────────────────────────

describe("B1) pedaço de history cuja janela não foi lida NÃO é guardado sem janela", () => {
  it("lança antes de gravar — nenhum payload, nenhum aviso; a reentrega grava com a janela e acorda o resolvedor", async () => {
    const b = banco();
    const value = pedaco([{ id: "wamid.B1", type: "media_placeholder", fromMe: true }]);
    b.falhas.onboarding = true;
    await expect(guardar(b, value)).rejects.toThrow("channel_sessions (janela do payload)");
    expect(b.t.meta_sincronizacao_payloads).toHaveLength(0);
    expect(b.t.event_log).toHaveLength(0);

    b.falhas.onboarding = false;
    expect(await guardar(b, value)).toBe("guardado");
    expect(b.t.meta_sincronizacao_payloads).toHaveLength(1);
    expect(b.t.meta_sincronizacao_payloads![0]).toMatchObject({ onboarding_em: O1 });
    expect(b.t.event_log!.map((e) => e.event_type)).toEqual([EVENTO_CHUNK_GUARDADO]);
  });

  it("canal SEM onboarding (leitura ok, coluna vazia): guardado sem janela, sem acordar resolvedor — e a reentrega deduplica", async () => {
    const b = banco({ channel_sessions: [{ id: SESSAO, organization_id: ORG, meta_phone_number_id: NUM, meta_onboarding_em: null, archived_at: null }] });
    const value = pedaco([]);
    expect(await guardar(b, value)).toBe("guardado");
    expect(await guardar(b, value)).toBe("duplicate");
    expect(b.t.meta_sincronizacao_payloads).toHaveLength(1);
    expect(b.t.meta_sincronizacao_payloads![0]!.onboarding_em).toBeNull();
    expect(b.t.event_log).toHaveLength(0);
  });
});

// ─── B2/B3) a janela faz parte da identidade ───────────────────────────────

/** Reconexão: o canal passa para outro onboarding. */
function reconectar(b: Banco, onboardingEm: string) {
  b.t.channel_sessions![0]!.meta_onboarding_em = onboardingEm;
}
const ANTES_DE_O2 = new Date("2026-10-01T12:00:00.000Z");
const AGORA_EM_O2 = new Date("2026-10-05T10:30:00.000Z");

describe("B2) o MESMO pedaço de history em O1 e em O2", () => {
  it("reentrega na mesma janela é duplicate; depois da reconexão é OUTRA linha, com a janela nova — e a correlação de O2 a lê", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado(), pedidoSolicitado(O2)] });
    const value = pedaco([{ id: "wamid.B2", type: "media_placeholder", fromMe: true }]);

    expect(await guardar(b, value)).toBe("guardado");
    expect(await guardar(b, value)).toBe("duplicate");

    reconectar(b, O2);
    expect(await guardar(b, value)).toBe("guardado");
    expect(b.t.meta_sincronizacao_payloads!.map((p) => p.onboarding_em)).toEqual([O1, O2]);

    // Um eco da mesma mídia chega na janela O2: a correlação de O2 acha o placeholder.
    expect((await ingestMetaEcho(b.admin, eco("wamid.B2", ANTES_DE_O2), { organizationId: ORG }, { agora: AGORA_EM_O2 })).status).toBe("em_espera");
    const r = await resolverEcosEmEspera(b.admin, janela(O2), AGORA_EM_O2);
    expect(r).toMatchObject({ historico: 1, promovidos: 0 });
    semEfeitoDeMensagem(b);
  });
});

describe("B3) o MESMO wamid em O1 e em O2", () => {
  // Uma reconexão DENTRO dos 7 dias de O1 — passado o teto, O1 promove o que sobrou, como deve.
  const O2_PERTO = "2026-09-29T10:00:00.000Z";
  const AGORA_EM_O2_PERTO = new Date("2026-09-29T10:30:00.000Z");
  it("são duas linhas: O1 não bloqueia O2; O2 correlaciona com O2, e O1 com O1", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado(), pedidoSolicitado(O2_PERTO)] });

    expect((await ingestMetaEcho(b.admin, eco("wamid.B3", ANTES), { organizationId: ORG }, { agora: AGORA })).status).toBe("em_espera");
    reconectar(b, O2_PERTO);
    expect((await ingestMetaEcho(b.admin, eco("wamid.B3", ANTES), { organizationId: ORG }, { agora: AGORA_EM_O2_PERTO })).status).toBe("em_espera");
    const linhas = () => b.t.meta_ecos_em_espera!.map((q) => `${q.onboarding_em === O1 ? "O1" : q.onboarding_em === O2_PERTO ? "O2" : "?"}=${q.estado}`).sort();
    expect(linhas()).toEqual(["O1=aguardando", "O2=aguardando"]);

    // A reentrega na MESMA janela continua uma linha só.
    expect((await ingestMetaEcho(b.admin, eco("wamid.B3", ANTES), { organizationId: ORG }, { agora: AGORA_EM_O2_PERTO })).status).toBe("em_espera");
    expect(b.t.meta_ecos_em_espera).toHaveLength(2);

    // O history de O2 traz o placeholder: só a linha de O2 é classificada.
    await guardar(b, pedaco([{ id: "wamid.B3", type: "media_placeholder", fromMe: true }]));
    expect(await resolverEcosEmEspera(b.admin, janela(O2_PERTO), AGORA_EM_O2_PERTO)).toMatchObject({ historico: 1, promovidos: 0 });
    expect(linhas()).toEqual(["O1=aguardando", "O2=historico"]);

    // A janela O1 não enxerga o history de O2.
    expect(await resolverEcosEmEspera(b.admin, janela(O1), AGORA_EM_O2_PERTO)).toMatchObject({ historico: 0, promovidos: 0, aguardando: 1 });

    // O history de O1 (guardado na janela O1) classifica a linha de O1.
    b.t.meta_sincronizacao_payloads!.push({
      organization_id: ORG,
      channel_session_id: SESSAO,
      onboarding_em: O1,
      campo: "history",
      payload: pedaco([{ id: "wamid.B3", type: "media_placeholder", fromMe: true }]),
      payload_hash: "o1-b3",
      recebido_em: AGORA.toISOString(),
    });
    expect(await resolverEcosEmEspera(b.admin, janela(O1), AGORA_EM_O2_PERTO)).toMatchObject({ historico: 1, promovidos: 0 });
    expect(linhas()).toEqual(["O1=historico", "O2=historico"]);
    semEfeitoDeMensagem(b);
  });
});

// ─── B4) mais pedaços que o max_rows do PostgREST ───────────────────────────

describe("B4) janela com mais de 1000 pedaços — o fim não sai de um recorte", () => {
  const hora = 60 * 60 * 1000;
  /** `n` pedaços da janela O1, na ordem de chegada; `quando(i)` dá o recebido_em do i-ésimo. */
  function pedacos(b: Banco, n: number, quando: (i: number) => number, ultimo?: { fase: number; progresso: number }) {
    for (let i = 1; i <= n; i++) {
      const fim = i === n && ultimo;
      b.t.meta_sincronizacao_payloads!.push({
        id: `pedaco-${String(i).padStart(5, "0")}`,
        organization_id: ORG,
        channel_session_id: SESSAO,
        onboarding_em: O1,
        campo: "history",
        payload: {},
        payload_hash: `h-${i}`,
        fase: fim ? ultimo.fase : 1,
        progresso: fim ? ultimo.progresso : i % 100,
        recebido_em: new Date(quando(i)).toISOString(),
      });
    }
  }
  const inicio = Date.parse(O1) + hora;

  it("controle: o banco de mentira corta a resposta em 1000, como o PostgREST", async () => {
    const b = banco();
    pedacos(b, 1500, () => inicio);
    const { data } = await (b.admin.from("meta_sincronizacao_payloads").select("id") as unknown as PromiseLike<{ data: unknown[] }>);
    expect(data).toHaveLength(MAX_ROWS);
  });

  it("fase 2/progresso 100 como pedaço nº 1.201: terminou — o pedaço de fim não se perde depois do milésimo", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    pedacos(b, 1201, (i) => inicio + i * 1000, { fase: 2, progresso: 100 });
    expect(await historicoTerminou(b.admin, janela(), new Date(inicio + 2 * hora))).toEqual({ terminou: true, motivo: "historico_completo" });
  });

  it("1.200 pedaços, os 1.100 primeiros velhos e os 100 últimos recentes: NÃO está parado", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    const agora = inicio + 10 * hora;
    pedacos(b, 1200, (i) => (i <= 1100 ? inicio + i * 1000 : agora - 30 * 60 * 1000 + i));
    expect(await historicoTerminou(b.admin, janela(), new Date(agora))).toEqual({ terminou: false, motivo: "historico_em_andamento" });
  });

  it("controle: os 1.200 velhos — aí sim está parado", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    const agora = inicio + 10 * hora;
    pedacos(b, 1200, (i) => inicio + i * 1000);
    expect(await historicoTerminou(b.admin, janela(), new Date(agora))).toEqual({ terminou: true, motivo: "historico_parado" });
  });

  it("erro de leitura dos pedaços LANÇA — nunca vira `terminou`", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    const original = b.admin.from.bind(b.admin);
    (b.admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = original(t) as unknown as Record<string, unknown>;
      if (t === "meta_sincronizacao_payloads") {
        q.limit = () => Promise.resolve({ data: null, error: { message: "timeout" } });
      }
      return q;
    };
    await expect(historicoTerminou(b.admin, janela(), new Date(inicio + 10 * hora))).rejects.toThrow("timeout");
  });
});

// ─── f) dois onboardings ────────────────────────────────────────────────────

describe("f) DOIS onboardings — as quarentenas não se enxergam", () => {
  it("o history da janela nova não classifica o eco da antiga, e o da antiga não classifica o da nova", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado(), pedidoSolicitado(O2)] });
    await ingestMetaEcho(b.admin, eco("wamid.O1", ANTES), { organizationId: ORG }, { agora: AGORA });

    // Reconexão: o canal passa para O2 e um eco antigo chega na janela nova.
    b.t.channel_sessions![0]!.meta_onboarding_em = O2;
    await ingestMetaEcho(b.admin, eco("wamid.O2", new Date("2026-10-01T12:00:00.000Z")), { organizationId: ORG }, { agora: AGORA });
    expect(b.t.meta_ecos_em_espera!.map((q) => [q.external_id, q.onboarding_em])).toEqual([
      ["wamid.O1", O1],
      ["wamid.O2", O2],
    ]);

    // O pedaço guardado AGORA é da janela O2, e cita os DOIS wamids.
    await guardar(
      b,
      pedaco([
        { id: "wamid.O1", type: "media_placeholder", fromMe: true },
        { id: "wamid.O2", type: "media_placeholder", fromMe: true },
      ]),
    );
    expect(b.t.meta_sincronizacao_payloads!.at(-1)).toMatchObject({ onboarding_em: O2 });

    expect(await resolverEcosEmEspera(b.admin, janela(O1), AGORA)).toMatchObject({ historico: 0 });
    expect(await resolverEcosEmEspera(b.admin, janela(O2), AGORA)).toMatchObject({ historico: 1 });
    expect(b.t.meta_ecos_em_espera!.map((q) => q.estado)).toEqual(["aguardando", "historico"]);

    // A contagem da tela é por janela.
    expect(await contarEcosEmEspera(b.admin, janela(O1))).toMatchObject({ aguardando: 1, historico: 0 });
    expect(await contarEcosEmEspera(b.admin, janela(O2))).toMatchObject({ aguardando: 0, historico: 1 });
  });
});

// ─── g) corrida entre resolvedores ──────────────────────────────────────────

describe("g) CORRIDA entre resolvedores", () => {
  it("dois resolvedores na mesma janela: uma mensagem, uma promoção", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.CORRIDA", ANTES), { organizationId: ORG }, { agora: AGORA });
    await historicoCompleto(b);

    const [r1, r2] = await Promise.all([
      resolverEcosEmEspera(b.admin, janela(), AGORA),
      resolverEcosEmEspera(b.admin, janela(), AGORA),
    ]);
    expect(r1.promovidos + r2.promovidos).toBe(1);
    expect(r1.duplicados + r2.duplicados).toBe(0);
    expect(b.t.messages).toHaveLength(1);
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "promovido" });
  });

  it("um eco já classificado como histórico nunca é promovido, nem com o history terminado", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.JA_HIST", ANTES), { organizationId: ORG }, { agora: AGORA });
    b.t.meta_ecos_em_espera![0]!.estado = "historico";
    await historicoCompleto(b);
    await resolverEcosEmEspera(b.admin, janela(), AGORA);
    expect(b.t.messages).toHaveLength(0);
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "historico" });
  });
});

// ─── Invariantes 2 e 3 ──────────────────────────────────────────────────────

describe("invariante: um wamid histórico não nasce por dois caminhos", () => {
  it("eco suspeito + `message_echoes` sob field=history + placeholder: zero mensagens; o importador depois é o único escritor", async () => {
    const b = banco({ meta_sincronizacoes: [pedidoSolicitado()] });
    await ingestMetaEcho(b.admin, eco("wamid.TRES", ANTES), { organizationId: ORG }, { agora: AGORA });
    await guardarPayloadDeSincronizacao(
      b.admin,
      {
        campo: "history",
        phoneNumberId: NUM,
        value: { metadata: { phone_number_id: NUM }, message_echoes: [{ id: "wamid.TRES", to: CLIENTE, type: "image", timestamp: "1790000000" }] },
      },
      { organizationId: ORG },
    );
    await guardar(b, pedaco([{ id: "wamid.TRES", type: "media_placeholder", fromMe: true }]));
    await historicoCompleto(b);
    await resolverEcosEmEspera(b.admin, janela(), AGORA);
    await resolverEcosEmEspera(b.admin, janela(), AGORA);

    expect(b.t.messages).toHaveLength(0);
    expect(b.t.meta_ecos_em_espera![0]).toMatchObject({ estado: "historico" });

    // O importador (futuro) grava a mensagem; um segundo caminho bate no unique.
    const importada = await b.admin.from("messages").insert({ organization_id: ORG, external_id: "wamid.TRES" });
    expect(importada.error).toBeNull();
    const segunda = await ingestMetaEcho(b.admin, eco("wamid.TRES", ANTES), { organizationId: ORG }, { agora: AGORA });
    expect(segunda).toEqual({ status: "duplicate" });
    expect(b.t.messages).toHaveLength(1);
  });
});

// ─── i/j) o parser e a guarda não mudaram de papel ──────────────────────────

const envelope = (...entry: unknown[]): MetaWebhookEnvelope => ({ object: "whatsapp_business_account", entry }) as MetaWebhookEnvelope;

describe("i) mensagem RECEBIDA segue a ingestão de sempre", () => {
  it("field=messages com timestamp antigo continua inbound_message — a quarentena é só do eco", () => {
    const [e] = parseMetaWebhook(
      envelope({
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: NUM },
              messages: [{ id: "wamid.IN", from: CLIENTE, timestamp: String(Math.floor(ANTES.getTime() / 1000)), type: "text", text: { body: "oi" } }],
            },
          },
        ],
      }),
    );
    expect(e).toMatchObject({ kind: "inbound_message", externalId: "wamid.IN" });
  });
});

describe("j) field=history com messages[]/message_echoes[] nunca é ingerido", () => {
  it("vira sync_payload; nem echo_message nem inbound_message", () => {
    const eventos = parseMetaWebhook(
      envelope(
        { id: WABA, changes: [{ field: "history", value: { metadata: { phone_number_id: NUM }, message_echoes: [{ id: "wamid.J1", to: CLIENTE, type: "image" }] } }] },
        { id: WABA, changes: [{ field: "history", value: { metadata: { phone_number_id: NUM }, messages: [{ id: "wamid.J2", from: CLIENTE, type: "audio" }] } }] },
      ),
    );
    expect(eventos.map((e) => e.kind)).toEqual(["sync_payload", "sync_payload"]);
  });

  it("guardar o pedaço só acorda o resolvedor: nenhuma mensagem, contato ou conversa", async () => {
    const b = banco();
    await guardar(b, pedaco([{ id: "wamid.J3", type: "media_placeholder", fromMe: true }]));
    semEfeitoDeMensagem(b);
    expect(b.rpcs.map((r) => r.nome)).toEqual(["emit_event"]);
    expect(b.t.event_log![0]).toMatchObject({ event_type: EVENTO_CHUNK_GUARDADO, payload: { channel_session_id: SESSAO, onboarding_em: O1 } });
  });
});
