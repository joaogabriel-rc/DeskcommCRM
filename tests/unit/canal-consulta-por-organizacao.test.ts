import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHANNEL_SESSION_REF_COLUMNS } from "@/lib/channels/session-ref";

/**
 * VARREDURA: consulta a `channel_sessions` por identificador de PROVIDER tem de
 * levar a organização junto.
 *
 * ─── Por que este arquivo existe (issue #236) ───────────────────────────────
 * Três consultas de `lib/channels/` resolviam uma sessão só pelo identificador
 * do provider (`meta_phone_number_id`, `zernio_account_id`), num client de
 * service role — que **bypassa RLS**. Esse identificador não era único: bastava
 * uma agência conectar a mesma conta em duas organizações (configuração
 * LEGÍTIMA — a rota de conexão exige que a chave informada alcance a conta) para
 * a consulta casar duas linhas. E `maybeSingle()` com duas linhas devolve
 * `data: null` com `error PGRST116` (medido contra @supabase/postgrest-js
 * 2.112.1), não "a primeira linha".
 *
 * Consertar as três instâncias não fecha a classe: o quarto canal chega com o
 * quinto identificador e repete. Esta varredura é o que fecha — e ela deriva as
 * colunas de `CHANNEL_SESSION_REF_COLUMNS`, a MESMA constante que o seam usa
 * para montar o `select`. Canal novo entra na varredura sem ninguém lembrar de
 * editar este arquivo.
 *
 * ─── O escopo é `lib/channels/`, e isso não é arbitrário ────────────────────
 * `docs/doctrine/restricao-de-canal.md` (invariante 1) proíbe nome de provider
 * fora deste diretório, e `pnpm lint:channels` reprova quem tenta — então é aqui
 * que uma resolução por identificador de provider PODE morar. Fora daqui as
 * consultas se resolvem por `id`, por `webhook_path_token` ou por
 * `waha_session_name`, que são UNIQUE no schema (conferido em `baseline.sql`:
 * `channel_sessions_pkey`, `channel_sessions_webhook_path_token_unique`,
 * `channel_sessions_waha_session_name_unique`) — resolução exata por
 * construção, que é a mesma propriedade que a migration 0165 passa a dar aos
 * dois identificadores novos.
 */
const RAIZ = process.cwd();
const DIR = path.join(RAIZ, "lib/channels");

/**
 * As colunas que IDENTIFICAM uma sessão no provider.
 *
 * `provider` sai da lista de propósito: ele é discriminador (qual canal), não
 * identificador (qual sessão) — filtrar por ele nunca pretendeu devolver UMA
 * linha, e cobrá-lo aqui reprovaria consultas corretas como a de
 * `meta/session.ts`, que já resolve por `webhook_path_token`.
 */
const COLUNAS_DE_REF = CHANNEL_SESSION_REF_COLUMNS.split(",")
  .map((c) => c.trim())
  .filter((c) => c !== "provider");

/**
 * As colunas que, sem `organization_id`, também resolvem o tenant: as de ref e a
 * WABA. `meta_waba_id` não é ref de sessão — a sessão é o NÚMERO, e por isso ela
 * fica fora de `CHANNEL_SESSION_REF_COLUMNS` —, mas filtrar por ela devolve as
 * sessões de TODA organização que conectou a mesma conta, que é o risco que esta
 * varredura existe para pegar. Sem ela aqui, a busca por WABA passava sem ser vista.
 */
const COLUNAS_QUE_RESOLVEM_TENANT = [...COLUNAS_DE_REF, "meta_waba_id"];

function arquivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosTs(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * EXCEÇÕES DECLARADAS — consultas que resolvem o tenant PELO identificador do
 * provider, de propósito. A lista não é álibi: cada entrada nomeia a função, o
 * porquê e quem decidiu, e os testes do fim deste arquivo prendem as condições
 * que tornam a exceção segura (ambiguidade recusada, um único chamador).
 */
const RESOLVEM_O_TENANT: ReadonlyArray<{ arquivo: string; funcao: string; motivo: string }> = [
  {
    arquivo: "lib/channels/meta/session.ts",
    funcao: "metaSessionByPhoneNumberId",
    motivo:
      "webhook UNIVERSAL da Meta (/api/v1/webhooks/meta): a organização é o que se quer descobrir. " +
      "O phone_number_id vem de um corpo com assinatura HMAC do App Secret da instalação, o dono vem " +
      "do banco (índice único 0165) e dono ambíguo não recebe nada. Decisão do dono do produto em " +
      "22/09/2026, com o custo aceito: quem tiver o App Secret forja evento para qualquer tenant.",
  },
  {
    arquivo: "lib/channels/meta/session.ts",
    funcao: "metaSessionsByWabaId",
    motivo:
      "webhook UNIVERSAL da Meta: message_template_status_update não traz número, só a WABA. O " +
      "template é da WABA e toda organização com sessão ativa nela o espelha (a conexão só aceita " +
      "WABA que o token da organização alcança); cada escrita é escopada pelo organization_id da " +
      "sessão. Várias linhas é o caso normal (agência), não ambiguidade. Mesma decisão de 22/09/2026.",
  },
];

interface Consulta {
  arquivo: string;
  linha: number;
  /** A função que contém a consulta — é por ela que uma exceção é declarada. */
  funcao: string | null;
  /** Filtros da cadeia em si — é onde o escopo de tenant tem de estar. */
  filtros: string[];
  /** Filtros da cadeia MAIS os do terminal. Ver o comentário abaixo. */
  filtrosComTerminal: string[];
}

/** `.eq("x", …)`, `.is(ARCHIVED_AT, null)` → nome da coluna filtrada. */
function colunasFiltradas(trecho: string): string[] {
  return [...trecho.matchAll(/\.(?:eq|is|in|neq|match)\(\s*(?:"([a-z_]+)"|(ARCHIVED_AT))/g)].map(
    (m) => m[1] ?? "archived_at",
  );
}

/**
 * Extrai as consultas a `channel_sessions` e os nomes de coluna filtrados.
 *
 * DOIS recortes, e a diferença não é preguiça de parser — ela espelha como este
 * diretório escreve consulta:
 *
 *   `filtros` vai do `.from("channel_sessions")` até o primeiro `;`, que é o fim
 *   da cadeia. É aí que o escopo de tenant tem de estar, e medir só isto impede
 *   que um `.eq("organization_id", …)` de uma instrução VIZINHA seja contado
 *   como se fosse desta — falso verde é pior que falso vermelho num gate.
 *
 *   `filtrosComTerminal` engloba também a instrução seguinte, e só quando a
 *   cadeia nasce dentro de uma CLOSURE (`const base = (…) => admin.from(…);`).
 *   Esse é o padrão obrigatório de `queryTolerantToMissingArchived`, que precisa
 *   de duas closures porque o cliente do PostgREST é thenable — e é no chamador,
 *   não na closure, que o `.is(ARCHIVED_AT, null)` aparece.
 */
function consultas(fonte: string, arquivo: string): Consulta[] {
  const out: Consulta[] = [];
  const marca = '.from("channel_sessions")';
  let i = fonte.indexOf(marca);
  while (i !== -1) {
    const fim = fonte.indexOf(";", i);
    const cadeia = fonte.slice(i, fim === -1 ? fonte.length : fim);

    const antes = fonte.slice(Math.max(0, i - 200), i);
    const nasceEmClosure = /=\s*\([^)]*\)\s*=>[\s\S]{0,120}$/.test(antes);
    const fim2 = nasceEmClosure && fim !== -1 ? fonte.indexOf(";", fim + 1) : fim;
    const comTerminal = fonte.slice(i, fim2 === -1 ? fonte.length : fim2);

    const funcoes = [...fonte.slice(0, i).matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)];
    out.push({
      arquivo: path.relative(RAIZ, arquivo),
      linha: fonte.slice(0, i).split("\n").length,
      funcao: funcoes.at(-1)?.[1] ?? null,
      filtros: colunasFiltradas(cadeia),
      filtrosComTerminal: colunasFiltradas(comTerminal),
    });
    i = fonte.indexOf(marca, i + marca.length);
  }
  return out;
}

const TODAS = arquivosTs(DIR).flatMap((a) => consultas(fs.readFileSync(a, "utf8"), a));

describe("lib/channels: consulta a channel_sessions por identificador do provider", () => {
  it("a varredura enxerga alguma consulta (senão ela mede o vazio)", () => {
    // Controle do instrumento. Sem isto, renomear a tabela, mover o diretório ou
    // quebrar o extrator deixaria o gate VERDE por não medir nada — o modo de
    // falha que `feedback_instrumento_quebrado_devolve_zero` descreve.
    expect(TODAS.length).toBeGreaterThanOrEqual(5);
    expect(COLUNAS_DE_REF).toContain("meta_phone_number_id");
    expect(COLUNAS_DE_REF).toContain("zernio_account_id");
    expect(COLUNAS_DE_REF).not.toContain("provider");
    // A varredura tem de ENXERGAR a busca por WABA — senão a exceção abaixo não prende nada.
    expect(COLUNAS_QUE_RESOLVEM_TENANT).toContain("meta_waba_id");
    expect(TODAS.some((c) => c.filtros.includes("meta_waba_id"))).toBe(true);
  });

  it("quem filtra por identificador do provider filtra organization_id também", () => {
    const faltando = TODAS.filter(
      (c) =>
        c.filtros.some((f) => COLUNAS_QUE_RESOLVEM_TENANT.includes(f)) &&
        !c.filtros.includes("organization_id") &&
        !RESOLVEM_O_TENANT.some((x) => x.arquivo === c.arquivo && x.funcao === c.funcao),
    ).map((c) => `${c.arquivo}:${c.linha} (filtros: ${c.filtros.join(", ") || "nenhum"})`);

    expect(
      faltando,
      "Este client é de service role e BYPASSA RLS. Identificador de provider não é " +
        "único por si só: com duas linhas, maybeSingle() devolve data:null + PGRST116 " +
        "e quem descarta o error cai no fallback do .env — a mensagem sai pela conta " +
        "de outra instalação (issue #236). Resolva o organization_id de fonte " +
        "confiável (sessão, linha já escopada, token do webhook), NUNCA do corpo.",
    ).toEqual([]);
  });

  it("quem filtra por identificador do provider recorta os ATIVOS", () => {
    // O índice único da migration 0165 é PARCIAL (`where archived_at is null`),
    // pelo precedente da 0107. Consulta que não usa o mesmo recorte lê um
    // conjunto MAIOR do que o que a trava garante — e volta a poder casar duas
    // linhas, justo no ponto em que o banco deixou de proteger.
    const semRecorte = TODAS.filter(
      (c) =>
        c.filtros.some((f) => COLUNAS_QUE_RESOLVEM_TENANT.includes(f)) &&
        !c.filtrosComTerminal.includes("archived_at"),
    ).map((c) => `${c.arquivo}:${c.linha}`);

    expect(
      semRecorte,
      "Filtre `archived_at is null` (use queryTolerantToMissingArchived, para o " +
        "clone sem a migration 0106 não quebrar): é o MESMO recorte dos índices " +
        "channel_sessions_meta_phone_number_id_ativo_unique e " +
        "channel_sessions_zernio_account_id_ativo_unique.",
    ).toEqual([]);
  });
});

describe("lib/channels: o erro da resolução não pode virar caminho feliz", () => {
  // Descartar o `error` era METADE do defeito: `const { data } = await ...`
  // transforma PGRST116 (duas linhas) em "não tem credencial gravada", e o
  // desfecho é o fallback do env — a ação segue, pela conta errada. Doutrina:
  // falhar FECHADO na ação, ABERTO na informação.
  const fontes = [
    "lib/channels/meta/credentials.ts",
    "lib/channels/zernio/credentials.ts",
    "lib/channels/meta/ingest.ts",
  ];

  for (const rel of fontes) {
    it(`${rel} lê o error da consulta e lança`, () => {
      const fonte = fs.readFileSync(path.join(RAIZ, rel), "utf8");
      expect(fonte).toMatch(/const \{ data, error \} = await queryTolerantToMissingArchived/);
      expect(fonte).toMatch(/if \(error\) \{\s*throw new Error\(/);
    });
  }
});

describe("lib/channels: as exceções que resolvem o tenant (número e WABA) continuam seguras", () => {
  it("toda exceção declarada existe de verdade (lista sem entrada morta)", () => {
    for (const x of RESOLVEM_O_TENANT) {
      expect(
        TODAS.some((c) => c.arquivo === x.arquivo && c.funcao === x.funcao),
        `${x.arquivo}#${x.funcao} não tem mais consulta a channel_sessions — tire da lista`,
      ).toBe(true);
    }
  });

  it("metaSessionByPhoneNumberId recusa dono ambíguo em vez de escolher um", () => {
    const fonte = fs.readFileSync(path.join(RAIZ, "lib/channels/meta/session.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("export async function metaSessionByPhoneNumberId"));
    const funcao = corpo.slice(0, corpo.indexOf("\n}\n") + 2);
    // `limit(2)` e não `maybeSingle()`: duas linhas têm de virar recusa, nunca palpite.
    expect(funcao).toMatch(/\.limit\(2\)/);
    expect(funcao).not.toMatch(/maybeSingle\(/);
    expect(funcao).toMatch(/linhas\.length > 1\) return \{ encontrada: false, motivo: "ambigua" \}/);
    expect(funcao).toMatch(/if \(error\) \{\s*throw new Error\(/);
  });

  it("só o webhook universal a chama — e ele confere a assinatura antes", () => {
    const chamadores = [...arquivosDoProduto(path.join(RAIZ, "app")), ...arquivosDoProduto(path.join(RAIZ, "lib"))]
      .filter((a) => fs.readFileSync(a, "utf8").includes("metaSessionByPhoneNumberId("))
      .map((a) => path.relative(RAIZ, a))
      .filter((a) => a !== "lib/channels/meta/session.ts");
    expect(chamadores).toEqual(["app/api/v1/webhooks/meta/route.ts"]);

    const rota = fs.readFileSync(path.join(RAIZ, "app/api/v1/webhooks/meta/route.ts"), "utf8");
    const post = rota.slice(rota.indexOf("export async function POST"));
    expect(post.indexOf("lerEntregaDaMeta(")).toBeGreaterThan(-1);
    expect(post.indexOf("lerEntregaDaMeta(")).toBeLessThan(post.indexOf("metaSessionByPhoneNumberId("));
    expect(post).toMatch(/if \(!leitura\.ok\) \{\s*return fail\(/);
  });

  it("metaSessionsByWabaId: só o webhook universal a chama, depois da assinatura, e a escrita é escopada", () => {
    const chamadores = [...arquivosDoProduto(path.join(RAIZ, "app")), ...arquivosDoProduto(path.join(RAIZ, "lib"))]
      .filter((a) => fs.readFileSync(a, "utf8").includes("metaSessionsByWabaId("))
      .map((a) => path.relative(RAIZ, a))
      .filter((a) => a !== "lib/channels/meta/session.ts");
    expect(chamadores).toEqual(["app/api/v1/webhooks/meta/route.ts"]);

    const rota = fs.readFileSync(path.join(RAIZ, "app/api/v1/webhooks/meta/route.ts"), "utf8");
    const post = rota.slice(rota.indexOf("export async function POST"));
    expect(post.indexOf("lerEntregaDaMeta(")).toBeGreaterThan(-1);
    expect(post.indexOf("lerEntregaDaMeta(")).toBeLessThan(post.indexOf("metaSessionsByWabaId("));

    // A busca devolve sessões de VÁRIAS organizações: o que as separa é a escrita
    // levar o organization_id da sessão, nunca o do corpo.
    const processar = fs.readFileSync(path.join(RAIZ, "lib/channels/meta/processar-evento.ts"), "utf8");
    const inicio = processar.indexOf('.from("meta_templates")');
    expect(inicio).toBeGreaterThan(-1);
    const escrita = processar.slice(inicio, processar.indexOf(";", inicio));
    expect(escrita).toMatch(/\.update\(/);
    expect(escrita).toMatch(/\.eq\("organization_id", sessao\.organizationId\)/);
  });
});

function arquivosDoProduto(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivosDoProduto(p);
    return e.isFile() && /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}
