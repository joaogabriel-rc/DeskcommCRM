/**
 * Um dublê do PostgREST que APLICA os filtros.
 *
 * Os dublês de uma linha (`eq: () => chain`) servem para provar que uma rota
 * CHAMOU o banco; eles não servem para provar RECORTE — um dublê que ignora o
 * `.eq("organization_id", …)` devolve a linha da outra organização e o teste
 * passa do mesmo jeito. Aqui cada `eq`/`is`/`in`/`or` filtra as linhas de
 * verdade, então "a organização A não vê o modelo da B" é medido, não suposto.
 *
 * Cobre o subconjunto do builder que as rotas de fluxos e o catálogo usam:
 * select/insert/update/upsert (com `onConflict`)/delete, eq/is/in/or/order/limit/range,
 * maybeSingle/single/then, e `rpc` por função registrada. `or` entende a forma
 * que `escopoDaConexao` monta: `col.eq.v,and(col.is.null,col.eq.v)`.
 */
import { randomUUID } from "node:crypto";

type Linha = Record<string, unknown>;
type Filtro = (l: Linha) => boolean;

export interface BancoEmMemoria {
  tabelas: Record<string, Linha[]>;
  rpcs: Record<string, (args: Record<string, unknown>) => unknown>;
  client: never;
}

/** `custom_fields->>chave` lê dentro do jsonb, como o PostgREST. */
function valorDe(l: Linha, col: string): unknown {
  const m = /^([a-z_]+)->>([a-z0-9_]+)$/.exec(col);
  if (!m) return l[col];
  const obj = l[m[1]!] as Record<string, unknown> | null | undefined;
  const v = obj?.[m[2]!];
  return v === undefined || v === null ? null : String(v);
}

/** `{"a,b","c"}` → ["a,b", "c"] (aspas com `\` escapando). */
function literalDeArray(txt: string): string[] {
  const corpo = txt.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: string[] = [];
  let i = 0;
  while (i < corpo.length) {
    if (corpo[i] === ",") {
      i++;
      continue;
    }
    if (corpo[i] === '"') {
      let s = "";
      i++;
      while (i < corpo.length && corpo[i] !== '"') {
        if (corpo[i] === "\\") i++;
        s += corpo[i];
        i++;
      }
      i++;
      out.push(s);
    } else {
      const fim = corpo.indexOf(",", i);
      out.push(corpo.slice(i, fim < 0 ? undefined : fim));
      i = fim < 0 ? corpo.length : fim;
    }
  }
  return out;
}

/** LIKE (sem caixa) → RegExp: `%`/`_` curingas, `\` escapa o seguinte. */
function likeParaRegex(padrao: string): RegExp {
  let rx = "";
  for (let i = 0; i < padrao.length; i++) {
    const c = padrao[i]!;
    if (c === "\\") {
      rx += (padrao[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") rx += ".*";
    else if (c === "_") rx += ".";
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`, "i");
}

function iguais(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return String(a) === String(b);
}

/** `"a \"b\""` → `a "b"`; valor sem aspas passa igual. */
function tirarAspas(v: string): string {
  if (!(v.startsWith('"') && v.endsWith('"'))) return v;
  return v.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** Divide no nível de cima, respeitando parênteses E aspas. */
function dividir(expr: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let atual = "";
  let aspas = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (aspas && c === "\\") {
      atual += c + (expr[++i] ?? "");
      continue;
    }
    if (c === '"') aspas = !aspas;
    if (!aspas && c === "(") nivel++;
    if (!aspas && c === ")") nivel--;
    if (c === "," && nivel === 0 && !aspas) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += c;
  }
  if (atual) partes.push(atual);
  return partes;
}

function filtroDeTermo(termo: string): Filtro {
  const t = termo.trim();
  if (t.startsWith("and(") && t.endsWith(")")) {
    const filhos = dividir(t.slice(4, -1)).map(filtroDeTermo);
    return (l) => filhos.every((f) => f(l));
  }
  if (t.startsWith("or(") && t.endsWith(")")) {
    const filhos = dividir(t.slice(3, -1)).map(filtroDeTermo);
    return (l) => filhos.some((f) => f(l));
  }
  const [col, op, ...resto] = t.split(".");
  let valor = resto.join(".");
  if (op === "not" && resto[0] === "is") return (l) => valorDe(l, col!) !== null;
  if (op === "not" && resto[0] === "ilike") {
    const rx = likeParaRegex(tirarAspas(resto.slice(1).join(".")));
    return (l) => !(typeof valorDe(l, col!) === "string" && rx.test(valorDe(l, col!) as string));
  }
  if (op === "not" && resto[0] === "imatch") {
    const rx = new RegExp(tirarAspas(resto.slice(1).join(".")), "i");
    return (l) => !(typeof valorDe(l, col!) === "string" && rx.test(valorDe(l, col!) as string));
  }
  valor = tirarAspas(valor);
  if (op === "imatch") {
    const rx = new RegExp(valor, "i");
    return (l) => typeof valorDe(l, col!) === "string" && rx.test(valorDe(l, col!) as string);
  }
  if (op === "eq") return (l) => iguais(valorDe(l, col!), valor);
  if (op === "neq") return (l) => valorDe(l, col!) !== null && !iguais(valorDe(l, col!), valor);
  if (op === "is" && valor === "null") return (l) => valorDe(l, col!) === null || valorDe(l, col!) === undefined;
  if (op === "ilike") {
    const rx = likeParaRegex(valor);
    return (l) => typeof valorDe(l, col!) === "string" && rx.test(valorDe(l, col!) as string);
  }
  if (op === "ov") {
    const lista = literalDeArray(valor);
    return (l) => lista.some((x) => ((l[col!] as unknown[]) ?? []).includes(x));
  }
  throw new Error(`banco-em-memoria: termo de or() não suportado: ${t}`);
}

export function criarBanco(
  // `object[]` e não `Linha[]`: a fixture pode ser uma interface tipada (sem
  // assinatura de índice); o banco a trata como linha genérica.
  tabelas: Record<string, object[]> = {},
  rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {},
  /** Os DEFAULTs das colunas, por tabela — o que o Postgres preencheria no INSERT. */
  padroes: Record<string, Linha> = {},
): BancoEmMemoria {
  const banco = { tabelas: tabelas as Record<string, Linha[]>, rpcs } as BancoEmMemoria;

  function from(tabela: string) {
    banco.tabelas[tabela] ??= [];
    const filtros: Filtro[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Linha | Linha[] | null = null;
    /** Colunas do `onConflict` do upsert: com a chave batendo, mescla em vez de inserir. */
    let chaveDoConflito: string[] = [];
    let limite: number | null = null;
    let ordens: Array<{ col: string; asc: boolean }> = [];
    let unico: "maybe" | "single" | null = null;
    let contagem = false;
    let soCabeca = false;

    const executar = (): { data: unknown; error: unknown; count?: number } => {
      const linhas = banco.tabelas[tabela]!;
      if (op === "insert" || op === "upsert") {
        const gravadas: Linha[] = [];
        for (const l of Array.isArray(payload) ? payload : [payload!]) {
          // Upsert com `onConflict`: a linha que já tem a mesma chave é
          // ATUALIZADA no lugar — como o `on conflict do update` do PostgREST.
          const existente =
            op === "upsert" && chaveDoConflito.length > 0
              ? linhas.find((x) => chaveDoConflito.every((c) => x[c] === l[c]))
              : undefined;
          if (existente) {
            Object.assign(existente, l);
            gravadas.push(existente);
            continue;
          }
          const nova = { id: randomUUID(), created_at: new Date().toISOString(), ...(padroes[tabela] ?? {}), ...l };
          linhas.push(nova);
          gravadas.push(nova);
        }
        return fechar(gravadas);
      }
      let alvo = linhas.filter((l) => filtros.every((f) => f(l)));
      if (op === "update") {
        for (const l of alvo) Object.assign(l, payload);
        return fechar(alvo);
      }
      if (op === "delete") {
        banco.tabelas[tabela] = linhas.filter((l) => !alvo.includes(l));
        return fechar(alvo);
      }
      for (const o of [...ordens].reverse()) {
        alvo = [...alvo].sort((a, b) => {
          const x = String(a[o.col] ?? "");
          const y = String(b[o.col] ?? "");
          return o.asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (limite !== null) alvo = alvo.slice(0, limite);
      if (contagem && soCabeca) return { data: null, error: null, count: alvo.length };
      return fechar(alvo);
    };

    const fechar = (resultado: Linha[]) => {
      const copia = resultado.map((l) => ({ ...l }));
      if (unico === "single") {
        return copia.length === 1
          ? { data: copia[0], error: null }
          : { data: null, error: { message: `esperava 1 linha, veio ${copia.length}`, code: "PGRST116" } };
      }
      if (unico === "maybe") return { data: copia[0] ?? null, error: null };
      return { data: copia, error: null };
    };

    const q = {
      select: (_cols?: string, opcoes?: { count?: string; head?: boolean }) => {
        if (opcoes?.count) contagem = true;
        if (opcoes?.head) soCabeca = true;
        return q;
      },
      insert: (l: Linha | Linha[]) => {
        op = "insert";
        payload = l;
        return q;
      },
      upsert: (l: Linha | Linha[], opcoes?: { onConflict?: string }) => {
        op = "upsert";
        payload = l;
        chaveDoConflito = (opcoes?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
        return q;
      },
      update: (l: Linha) => {
        op = "update";
        payload = l;
        return q;
      },
      delete: () => {
        op = "delete";
        return q;
      },
      eq: (col: string, v: unknown) => {
        filtros.push((l) => iguais(valorDe(l, col), v));
        return q;
      },
      is: (col: string, _v: null) => {
        filtros.push((l) => valorDe(l, col) === null || valorDe(l, col) === undefined);
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        filtros.push((l) => vs.some((v) => iguais(l[col], v)));
        return q;
      },
      or: (expr: string) => {
        const f = filtroDeTermo(`or(${expr})`);
        filtros.push(f);
        return q;
      },
      // Os filtros da segmentação dos disparos, na semântica do Postgres:
      // `cs` = contém todos, `ov` = tem algum, `is null`, e LIKE com `\` escapando.
      contains: (col: string, v: unknown) => {
        const lista = typeof v === "string" ? literalDeArray(v) : (v as unknown[]);
        filtros.push((l) => lista.every((x) => ((l[col] as unknown[]) ?? []).includes(x)));
        return q;
      },
      overlaps: (col: string, v: unknown) => {
        const lista = typeof v === "string" ? literalDeArray(v) : (v as unknown[]);
        filtros.push((l) => lista.some((x) => ((l[col] as unknown[]) ?? []).includes(x)));
        return q;
      },
      not: (col: string, op: string, v: unknown) => {
        if (op === "is") filtros.push((l) => valorDe(l, col) !== null && valorDe(l, col) !== undefined);
        else if (op === "ov") {
          const lista = literalDeArray(String(v));
          filtros.push((l) => !lista.some((x) => ((l[col] as unknown[]) ?? []).includes(x)));
        } else throw new Error(`banco-em-memoria: not(${op}) não suportado`);
        return q;
      },
      // `imatch` = `~*` do Postgres (regex sem caixa). O escape de regex do
      // Postgres (`\` + metacaractere) é o mesmo do JavaScript para os
      // metacaracteres que `regexDeContem` escapa.
      filter: (col: string, op: string, v: unknown) => {
        if (op !== "imatch") throw new Error(`banco-em-memoria: filter(${op}) não suportado`);
        const rx = new RegExp(String(v), "i");
        filtros.push((l) => typeof valorDe(l, col) === "string" && rx.test(valorDe(l, col) as string));
        return q;
      },
      ilike: (col: string, padrao: string) => {
        const rx = likeParaRegex(padrao);
        filtros.push((l) => typeof valorDe(l, col) === "string" && rx.test(valorDe(l, col) as string));
        return q;
      },
      order: (col: string, opcoes?: { ascending?: boolean }) => {
        ordens.push({ col, asc: opcoes?.ascending ?? true });
        return q;
      },
      limit: (n: number) => {
        limite = n;
        return q;
      },
      range: (de: number, ate: number) => {
        limite = ate - de + 1;
        return q;
      },
      maybeSingle: async () => {
        unico = "maybe";
        return executar();
      },
      single: async () => {
        unico = "single";
        return executar();
      },
      then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(executar()).then(ok, erro);
        } catch (e) {
          return erro ? erro(e) : Promise.reject(e);
        }
      },
    };
    ordens = [];
    return q;
  }

  banco.client = {
    from,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      const fn = banco.rpcs[nome];
      if (!fn) return { data: null, error: { message: `rpc ${nome} não registrada` } };
      try {
        return { data: await fn(args), error: null };
      } catch (e) {
        return { data: null, error: e };
      }
    },
  } as never;
  return banco;
}
