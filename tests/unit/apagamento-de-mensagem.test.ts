/**
 * MENSAGEM APAGADA — o conteúdo da RECEBIDA sai de todo lugar; a ENVIADA fica
 * visível para a equipe (decisão do dono do produto, 10/11/2026).
 *
 * O banco aqui é em memória, mas com o que importa do real: filtro por caminho
 * JSON (`payload->>message_id`), `is`/`not is null`, ordem, `updated_at`
 * carimbado a cada escrita (o trigger `trg_messages_updated_at`), o único de
 * `storage_redaction_queue (bucket, object_path)` e falha injetável por tabela.
 * Um dublê que aceitasse qualquer filtro provaria só que a função chama o banco
 * — não que ela acerta a linha certa, da organização certa.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  apagarMensagem,
  metadataDaRecebidaApagada,
  PREVIA_DE_MENSAGEM_APAGADA,
  semConteudoApagado,
} from "@/lib/messaging/apagamento";

type Linha = Record<string, unknown>;
type Erro = { code: string; message: string };

let tabelas: Record<string, Linha[]>;
let relogio = 0;
/** `tabela:op` → erro devolvido na PRÓXIMA operação desse tipo. */
let falhas: Record<string, Erro> = {};
/** Escrita concorrente injetada logo depois da leitura da mensagem. */
let concorrente: (() => void) | null = null;
let leiturasDaMensagem = 0;

function caminho(l: Linha, col: string): unknown {
  const partes = col.split(/->>?/);
  let v: unknown = l;
  for (const p of partes) v = v && typeof v === "object" ? (v as Linha)[p] : undefined;
  return v;
}

function carimbo() {
  relogio += 1;
  return `2026-11-10T00:00:${String(relogio).padStart(2, "0")}Z`;
}

function consulta(tabela: string, op: "select" | "update" | "delete" | "insert", payload?: unknown) {
  const filtros: Array<(l: Linha) => boolean> = [];
  let ordem: { col: string; asc: boolean } | null = null;
  let limite: number | null = null;
  let unica = false;

  const executar = () => {
    const falha = falhas[`${tabela}:${op}`];
    if (falha) {
      delete falhas[`${tabela}:${op}`];
      return { data: null, error: falha };
    }
    const t = (tabelas[tabela] ??= []);
    if (op === "insert") {
      const nova: Linha = { id: `q${t.length + 1}`, ...(payload as Linha) };
      if (
        tabela === "storage_redaction_queue" &&
        t.some((x) => x.bucket === nova.bucket && x.object_path === nova.object_path)
      ) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      t.push(nova);
      return { data: [nova], error: null };
    }
    let alvo = t.filter((l) => filtros.every((f) => f(l)));
    if (ordem) {
      const { col, asc } = ordem;
      alvo = [...alvo].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limite !== null) alvo = alvo.slice(0, limite);
    if (op === "delete") {
      tabelas[tabela] = t.filter((l) => !alvo.includes(l));
      return { data: alvo, error: null };
    }
    if (op === "update") {
      for (const l of alvo) {
        Object.assign(l, payload as Linha);
        if (tabela === "messages") l.updated_at = carimbo();
      }
    }
    const data = alvo.map((l) => structuredClone(l));
    if (tabela === "messages" && op === "select" && unica) {
      leiturasDaMensagem += 1;
      const r = { data: data[0] ?? null, error: null };
      if (concorrente) {
        const c = concorrente;
        concorrente = null;
        c();
      }
      return r;
    }
    return { data: unica ? (data[0] ?? null) : data, error: null };
  };

  const q: Record<string, unknown> = {
    select: () => q,
    eq: (col: string, v: unknown) => (filtros.push((l) => caminho(l, col) === v), q),
    is: (col: string, v: unknown) => (filtros.push((l) => (caminho(l, col) ?? null) === v), q),
    not: (col: string, _op: string, v: unknown) => (filtros.push((l) => (caminho(l, col) ?? null) !== v), q),
    order: (col: string, o: { ascending: boolean }) => ((ordem = { col, asc: o.ascending }), q),
    limit: (n: number) => ((limite = n), q),
    maybeSingle: () => ((unica = true), q),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(executar()).then(ok, ko),
  };
  return q;
}

const admin = {
  from: (t: string) => ({
    select: () => consulta(t, "select"),
    update: (p: unknown) => consulta(t, "update", p),
    delete: () => consulta(t, "delete"),
    insert: (p: unknown) => consulta(t, "insert", p),
  }),
} as never;

const ORG = "org-a";
const OUTRA = "org-b";

function recebida(extra: Linha = {}): Linha {
  return {
    id: "m1",
    organization_id: ORG,
    conversation_id: "c1",
    external_id: "wamid.X",
    direction: "inbound",
    type: "image",
    body: "SEGREDO: meu CPF é 000.000.000-00",
    media_url: "https://cdn/x.jpg",
    media_mime: "image/jpeg",
    media_size_bytes: 1234,
    media_storage_path: `${ORG}/c1/x.jpg`,
    media_derived_text: "transcrição com o SEGREDO",
    media_derived_status: "done",
    revoked_at: null,
    sent_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    metadata: {
      raw_type: "image",
      source: "meta",
      meta_tipo: "image",
      caption: "SEGREDO na legenda",
      media_id: "MID-123",
      meta_original: {
        id: "wamid.X",
        from: "5562",
        timestamp: "1",
        type: "image",
        image: { id: "MID-123", caption: "SEGREDO" },
        context: { id: "wamid.antes", from: "5562", referred_product: { x: 1 } },
      },
    },
    ...extra,
  };
}

function apagar(messageId = "m1", organizationId = ORG) {
  return apagarMensagem(admin, { organizationId, messageId, quando: "2026-11-10T12:00:00Z", canal: "meta" });
}

const msg = (id = "m1") => tabelas.messages!.find((m) => m.id === id)!;

beforeEach(() => {
  relogio = 0;
  falhas = {};
  concorrente = null;
  leiturasDaMensagem = 0;
  tabelas = {
    messages: [recebida()],
    conversations: [
      { id: "c1", organization_id: ORG, last_message_preview: "SEGREDO: meu CPF", usable_for_rag_marked_at: "2026-11-01T00:00:00Z" },
    ],
    event_log: [
      { id: "e1", organization_id: ORG, payload: { message_id: "m1", body_preview: "SEGREDO: meu CPF", direction: "inbound" } },
      { id: "e2", organization_id: ORG, payload: { message_id: "outra", body_preview: "fica" } },
    ],
    webhook_events_log: [
      { id: "w1", organization_id: ORG, external_id: "wamid.X", raw_body: "{SEGREDO}", payload_parsed: { a: 1 }, headers: { h: 1 } },
      { id: "w2", organization_id: ORG, external_id: null, raw_body: "{SEGREDO waha}", payload_parsed: { payload: { id: "wamid.X" } }, headers: {} },
      { id: "w3", organization_id: ORG, external_id: "wamid.OUTRO", raw_body: "{fica}", payload_parsed: {}, headers: {} },
    ],
    ai_chunks: [
      { id: "k1", organization_id: ORG, metadata: { conversation_id: "c1" }, content: "SEGREDO indexado" },
      { id: "k2", organization_id: ORG, metadata: { conversation_id: "c2" }, content: "outra conversa" },
    ],
    storage_redaction_queue: [],
  };
});

describe("recebida apagada pelo contato — o conteúdo sai de todo lugar", () => {
  it("a linha fica, sem conteúdo: corpo, mídia e transcrição nulos; `revoked_at` carimbado", async () => {
    expect(await apagar()).toEqual({ status: "apagada" });
    const m = msg();
    expect(tabelas.messages).toHaveLength(1);
    for (const col of ["body", "media_url", "media_mime", "media_size_bytes", "media_storage_path", "media_derived_text", "media_derived_status"]) {
      expect(m[col], col).toBeNull();
    }
    expect(m.revoked_at).toBe("2026-11-10T12:00:00Z");
    // rastreabilidade: id, tipo, direção, conversa e quando.
    expect(m).toMatchObject({ id: "m1", type: "image", direction: "inbound", conversation_id: "c1", external_id: "wamid.X" });
  });

  it("o `metadata` guarda só o técnico — legenda, id da mídia e o item cru da Meta saem", async () => {
    await apagar();
    const meta = msg().metadata as Linha;
    expect(JSON.stringify(meta)).not.toMatch(/SEGREDO|MID-123|referred_product/);
    expect(meta).toMatchObject({ raw_type: "image", source: "meta", meta_tipo: "image", meta_original_sanitizado: "revoke" });
    expect(meta.meta_original).toEqual({ id: "wamid.X", from: "5562", timestamp: "1", type: "image", context: { id: "wamid.antes", from: "5562" } });
    expect(meta.apagamento).toEqual({ em: "2026-11-10T12:00:00Z", por: "contato", canal: "meta", conteudo: "removido" });
  });

  it("a prévia da conversa vira o aviso quando a apagada é a última", async () => {
    await apagar();
    expect(tabelas.conversations![0]!.last_message_preview).toBe(PREVIA_DE_MENSAGEM_APAGADA);
  });

  it("a prévia NÃO é trocada quando já chegou mensagem depois", async () => {
    tabelas.messages!.push({ ...recebida({ id: "m2", sent_at: "2026-11-10T11:00:00Z", body: "depois" }) });
    tabelas.conversations![0]!.last_message_preview = "depois";
    await apagar();
    expect(tabelas.conversations![0]!.last_message_preview).toBe("depois");
  });

  it("o `body_preview` dos eventos DESTA mensagem sai; o resto do evento e os outros ficam", async () => {
    await apagar();
    expect(tabelas.event_log![0]!.payload).toEqual({ message_id: "m1", direction: "inbound" });
    expect(tabelas.event_log![1]!.payload).toEqual({ message_id: "outra", body_preview: "fica" });
  });

  it("os arquivos crus do webhook (Meta por `external_id`, WAHA pelo id no payload) perdem o corpo", async () => {
    await apagar();
    const [w1, w2, w3] = tabelas.webhook_events_log!;
    for (const w of [w1!, w2!]) {
      expect(w.raw_body).toBeNull();
      expect(w.payload_parsed).toBeNull();
      expect(w.headers).toBeNull();
      expect(w.archived_at).toBeTruthy();
    }
    expect(w3!.raw_body).toBe("{fica}");
  });

  it("o RAG perde os trechos da conversa e ela volta à fila de indexação", async () => {
    await apagar();
    expect(tabelas.ai_chunks!.map((k) => k.id)).toEqual(["k2"]);
    expect(tabelas.conversations![0]!.usable_for_rag_marked_at).not.toBe("2026-11-01T00:00:00Z");
  });

  it("conversa que nunca foi para o RAG não entra na fila por causa do apagamento", async () => {
    tabelas.conversations![0]!.usable_for_rag_marked_at = null;
    await apagar();
    expect(tabelas.conversations![0]!.usable_for_rag_marked_at).toBeNull();
  });

  it("o arquivo da mídia entra na fila durável do Storage, uma vez", async () => {
    await apagar();
    expect(tabelas.storage_redaction_queue).toEqual([
      expect.objectContaining({ organization_id: ORG, bucket: "whatsapp-media", object_path: `${ORG}/c1/x.jpg` }),
    ]);
  });

  it("arquivo já enfileirado por corrida (23505) não é falha", async () => {
    // Outra tentativa enfileirou entre a busca e o insert: o insert devolve 23505.
    const original = admin as unknown as { from: (t: string) => Record<string, unknown> };
    const from = original.from;
    original.from = (t: string) => {
      const o = from(t);
      if (t !== "storage_redaction_queue") return o;
      return { ...o, select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) };
    };
    tabelas.storage_redaction_queue!.push({ id: "q0", organization_id: ORG, bucket: "whatsapp-media", object_path: `${ORG}/c1/x.jpg` });
    try {
      expect(await apagar()).toEqual({ status: "apagada" });
    } finally {
      original.from = from;
    }
  });
});

describe("enviada apagada pela empresa — segue visível só aqui no CRM", () => {
  beforeEach(() => {
    tabelas.messages = [recebida({ direction: "outbound", body: "texto da empresa" })];
  });

  it("só ganha `revoked_at`: corpo, mídia e metadata ficam", async () => {
    expect(await apagar()).toEqual({ status: "apagada" });
    const m = msg();
    expect(m.revoked_at).toBe("2026-11-10T12:00:00Z");
    expect(m.body).toBe("texto da empresa");
    expect(m.media_storage_path).toBe(`${ORG}/c1/x.jpg`);
    expect((m.metadata as Linha).caption).toBe("SEGREDO na legenda");
  });

  it("não toca em prévia, eventos, arquivos, RAG nem Storage", async () => {
    const antes = structuredClone({ ...tabelas, messages: [] });
    await apagar();
    expect({ ...tabelas, messages: [] }).toEqual(antes);
  });

  it("segunda vez é `ja_apagada` e não muda o carimbo", async () => {
    await apagar();
    expect(await apagarMensagem(admin, { organizationId: ORG, messageId: "m1", quando: "2099-01-01T00:00:00Z", canal: "meta" })).toEqual({ status: "ja_apagada" });
    expect(msg().revoked_at).toBe("2026-11-10T12:00:00Z");
  });
});

describe("idempotência, concorrência e organização", () => {
  it("reaplicar é `ja_apagada`, mantém o primeiro carimbo e não enfileira de novo", async () => {
    await apagar();
    expect(await apagarMensagem(admin, { organizationId: ORG, messageId: "m1", quando: "2099-01-01T00:00:00Z", canal: "waha" })).toEqual({ status: "ja_apagada" });
    expect(msg().revoked_at).toBe("2026-11-10T12:00:00Z");
    expect((msg().metadata as Linha).apagamento).toMatchObject({ em: "2026-11-10T12:00:00Z", canal: "meta" });
    expect(tabelas.storage_redaction_queue).toHaveLength(1);
  });

  it("linha que já tinha `revoked_at` da regra antiga (com corpo) é limpa na reentrega", async () => {
    tabelas.messages = [recebida({ revoked_at: "2026-10-01T00:00:00Z" })];
    expect(await apagar()).toEqual({ status: "ja_apagada" });
    expect(msg().body).toBeNull();
    expect(msg().revoked_at).toBe("2026-10-01T00:00:00Z");
    expect(tabelas.event_log![0]!.payload).not.toHaveProperty("body_preview");
  });

  it("escrita concorrente entre a leitura e o update: relê e aplica sobre a versão nova", async () => {
    concorrente = () => {
      const m = msg();
      m.metadata = { ...(m.metadata as Linha), ack_name: "READ" };
      m.updated_at = "2026-11-10T11:59:59Z";
    };
    expect(await apagar()).toEqual({ status: "apagada" });
    // 2 tentativas × (a linha + "qual é a última da conversa").
    expect(leiturasDaMensagem).toBe(4);
    expect(msg().body).toBeNull();
    expect((msg().metadata as Linha).ack_name).toBe("READ");
  });

  it("conflito que não cessa vira falha 40001 — nunca um 'apagada' falso", async () => {
    const ciclo = () => {
      msg().updated_at = `x${Math.random()}`;
      concorrente = ciclo;
    };
    concorrente = ciclo;
    const r = await apagar();
    expect(r).toMatchObject({ status: "falhou", tabela: "messages", erro: { code: "40001" } });
    expect(msg().body).not.toBeNull();
  });

  it("outra organização não acha a mensagem nem toca em nada", async () => {
    const antes = structuredClone(tabelas);
    expect(await apagar("m1", OUTRA)).toEqual({ status: "nao_encontrada" });
    expect(tabelas).toEqual(antes);
  });

  it("os efeitos fora da linha ficam presos à organização da mensagem", async () => {
    tabelas.event_log!.push({ id: "eX", organization_id: OUTRA, payload: { message_id: "m1", body_preview: "da outra org" } });
    tabelas.webhook_events_log!.push({ id: "wX", organization_id: OUTRA, external_id: "wamid.X", raw_body: "{outra org}", payload_parsed: {}, headers: {} });
    tabelas.ai_chunks!.push({ id: "kX", organization_id: OUTRA, metadata: { conversation_id: "c1" }, content: "outra org" });
    await apagar();
    expect(tabelas.event_log!.find((e) => e.id === "eX")!.payload).toHaveProperty("body_preview", "da outra org");
    expect(tabelas.webhook_events_log!.find((w) => w.id === "wX")!.raw_body).toBe("{outra org}");
    expect(tabelas.ai_chunks!.some((k) => k.id === "kX")).toBe(true);
  });
});

describe("falha do banco — devolvida, e a linha só é tocada depois de tudo fora dela", () => {
  for (const [chave, tabela] of [
    ["messages:select", "messages"],
    ["conversations:update", "conversations"],
    ["event_log:select", "event_log"],
    ["event_log:update", "event_log"],
    ["webhook_events_log:update", "webhook_events_log"],
    ["ai_chunks:delete", "ai_chunks"],
    ["storage_redaction_queue:select", "storage_redaction_queue"],
    ["storage_redaction_queue:insert", "storage_redaction_queue"],
  ] as const) {
    it(`${chave} falha → 'falhou' em ${tabela}, e o corpo ainda está lá para a reentrega`, async () => {
      falhas[chave] = { code: "08006", message: "conexão caiu" };
      const r = await apagar();
      expect(r).toMatchObject({ status: "falhou", tabela, erro: { code: "08006" } });
      expect(msg().body).not.toBeNull();
      expect(msg().revoked_at).toBeNull();
      // e a reentrega completa o trabalho
      expect(await apagar()).toEqual({ status: "apagada" });
      expect(msg().body).toBeNull();
    });
  }

  it("o update da própria linha falha → 'falhou' em messages", async () => {
    falhas["messages:update"] = { code: "57P01", message: "admin shutdown" };
    expect(await apagar()).toMatchObject({ status: "falhou", tabela: "messages" });
  });
});

describe("funções puras", () => {
  it("`metadataDaRecebidaApagada` é lista de PERMITIDOS: chave nova de canal sai", () => {
    const m = metadataDaRecebidaApagada({ raw_type: "x", anexo_novo: "SEGREDO", cartao: { a: 1 } }, { em: "t", canal: "zernio" });
    expect(m).toEqual({ raw_type: "x", apagamento: { em: "t", por: "contato", canal: "zernio", conteudo: "removido" } });
  });

  it("`semConteudoApagado` mascara a recebida apagada e deixa a enviada apagada intacta", () => {
    const r = semConteudoApagado(recebida({ revoked_at: "2026-11-10T12:00:00Z" }));
    expect(r.body).toBeNull();
    expect(r.media_url).toBeNull();
    expect(JSON.stringify(r.metadata)).not.toMatch(/SEGREDO|MID-123/);
    const env = recebida({ direction: "outbound", revoked_at: "2026-11-10T12:00:00Z" });
    expect(semConteudoApagado(env)).toBe(env);
    const viva = recebida();
    expect(semConteudoApagado(viva)).toBe(viva);
  });

  it("`semConteudoApagado` não inventa colunas que a consulta não pediu", () => {
    const r = semConteudoApagado({ id: "m", direction: "inbound", revoked_at: "t", body: "x" });
    expect(Object.keys(r).sort()).toEqual(["body", "direction", "id", "revoked_at"]);
  });
});
