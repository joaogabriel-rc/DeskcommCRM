import { describe, expect, it } from "vitest";

import {
  citar,
  contarPublico,
  expressaoDoSegmento,
  filtrosDoSegmento,
  listarPublico,
  literalDeTags,
  regexDeContem,
} from "@/lib/disparos/segmento";
import { SEGMENTO_VAZIO, segmentoSchema, type Segmento } from "@/lib/schemas/disparos";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * A SEGMENTAÇÃO DOS DISPAROS — a mesma expressão para contar, listar e mostrar.
 *
 * Sob prova:
 *   1. texto do operador (etiqueta, valor) nunca vira SINTAXE da expressão:
 *      vírgula, aspas, parêntese, `%`, `_` e `\` chegam como texto;
 *   2. a CHAVE do campo, que vira nome de coluna, só passa na regra do registro;
 *   3. a organização é sempre o primeiro filtro, fora de qualquer `or()`;
 *   4. E, OU e NÃO têm a forma declarada no schema;
 *   5. contagem e listagem penduram EXATAMENTE os mesmos filtros;
 *   6. segmento gravado antes dos grupos novos gera os mesmos filtros de antes.
 *
 * A PROVA contra o PostgREST de verdade (o que ele faz com essas aspas) está no
 * e2e `disparo-guiado-e-com-fluxo.spec.ts`, que conta pela rota real.
 */

const ORG = "org-a";
const seg = (s: Partial<Segmento>): Segmento => ({ ...SEGMENTO_VAZIO, ...s });

function porMetodo(f: ReturnType<typeof filtrosDoSegmento>, metodo: string) {
  return f.filter((x) => x.metodo === metodo);
}

describe("texto do operador nunca vira sintaxe", () => {
  it("vírgula numa etiqueta: fica DENTRO das aspas do literal, não separa em duas", () => {
    expect(literalDeTags(["Cliente, VIP", "ouro"])).toBe('{"Cliente, VIP","ouro"}');
    const f = filtrosDoSegmento(ORG, seg({ tags_all: ["Cliente, VIP"] }));
    expect(porMetodo(f, "contains")).toEqual([{ metodo: "contains", coluna: "tags", valor: '{"Cliente, VIP"}' }]);
  });

  it("vírgula e parêntese num valor do grupo OU: o termo inteiro entre aspas", () => {
    const f = filtrosDoSegmento(ORG, seg({ fields_any: [{ key: "cidade", op: "eq", value: "Brasília, DF (Asa Sul)" }] }));
    expect(porMetodo(f, "or")).toEqual([{ metodo: "or", expressao: 'custom_fields->>cidade.eq."Brasília, DF (Asa Sul)"' }]);
  });

  it("aspas e barra invertida são escapadas dentro das aspas", () => {
    expect(citar('diz "oi" \\ tchau')).toBe('"diz \\"oi\\" \\\\ tchau"');
  });

  it('"contém" vira regex LITERAL (imatch), não LIKE — o PostgREST não deixa escapar `*` num LIKE', () => {
    const f = filtrosDoSegmento(ORG, seg({ fields: [{ key: "plano", op: "contains", value: "50%_off" }] }));
    expect(porMetodo(f, "imatch")).toEqual([{ metodo: "imatch", coluna: "custom_fields->>plano", regex: "50%_off" }]);
    expect(porMetodo(f, "ilike")).toEqual([]);
  });

  describe("cada caractere do valor de \"contém\" é texto", () => {
    // `%` e `_` não são metacaracteres de REGEX: ficam como estão. O resto, escapado.
    it.each([
      ["50%", "50%"],
      ["_", "_"],
      ["*", "\\*"],
      ["a,b", "a,b"],
      ['diz "oi"', 'diz "oi"'],
      ["a\\b", "a\\\\b"],
      ["1.5 (x) [y] {z} ^$|?+", "1\\.5 \\(x\\) \\[y\\] \\{z\\} \\^\\$\\|\\?\\+"],
    ])("%s", (valor, esperado) => {
      expect(regexDeContem(valor)).toBe(esperado);
    });

    it("dentro do grupo OU o termo vai entre aspas, com `\\` e aspas escapadas (vírgula não separa)", () => {
      const f = filtrosDoSegmento(ORG, seg({ fields_any: [{ key: "plano", op: "contains", value: 'a*b, "c" \\d' }] }));
      expect(porMetodo(f, "or")).toEqual([
        { metodo: "or", expressao: 'custom_fields->>plano.imatch."a\\\\*b, \\"c\\" \\\\\\\\d"' },
      ]);
    });
  });

  describe("o `*` literal NÃO vira curinga — medido contra linhas", () => {
    // O dublê aplica `imatch` como o Postgres (regex sem caixa). A prova contra o
    // PostgREST DE VERDADE está no e2e `disparo-guiado-e-com-fluxo.spec.ts`.
    const contatos = [
      { id: "estrela", valor: "a*b" },
      { id: "sem-estrela", valor: "aXXb" },
      { id: "cinquenta", valor: "50% off" },
      { id: "quinhentos", valor: "500 off" },
      { id: "sublinhado", valor: "x_y" },
      { id: "barra", valor: "c:\\pasta" },
      { id: "aspas", valor: 'diz "oi", tchau' },
    ].map((c) => ({
      id: c.id,
      organization_id: ORG,
      is_blocked: false,
      is_anonymized: false,
      is_merged_into: null,
      phone_number: "+55",
      tags: [],
      custom_fields: { plano: c.valor },
      created_at: c.id,
    }));

    async function quem(valor: string, grupo: "fields" | "fields_any" = "fields") {
      const db = criarBanco({ contacts: structuredClone(contatos) }).client;
      const { contatos: achados } = await listarPublico(db, ORG, seg({ [grupo]: [{ key: "plano", op: "contains", value: valor }] }), {
        limite: 50,
        offset: 0,
      });
      return achados.map((c) => c.id).sort();
    }

    it.each([
      ["*", ["estrela"]],
      ["a*b", ["estrela"]],
      ["50%", ["cinquenta"]],
      ["_", ["sublinhado"]],
      [",", ["aspas"]],
      ['"oi"', ["aspas"]],
      ["\\pasta", ["barra"]],
    ])("contém %j acha só %j", async (valor, esperado) => {
      expect(await quem(valor)).toEqual(esperado);
      expect(await quem(valor, "fields_any")).toEqual(esperado);
    });
  });

  it("valor do grupo E com vírgula vai por .eq() como parâmetro, sem virar lista", () => {
    const f = filtrosDoSegmento(ORG, seg({ fields: [{ key: "cidade", op: "eq", value: "a,b" }] }));
    expect(f).toContainEqual({ metodo: "eq", coluna: "custom_fields->>cidade", valor: "a,b" });
  });

  it("a CHAVE que vira coluna só passa na regra do registro — schema e tradutor recusam", () => {
    const tentativa = { key: "plano,organization_id.neq.x", op: "eq", value: "1" };
    expect(segmentoSchema.safeParse({ fields: [tentativa] }).success).toBe(false);
    expect(() => filtrosDoSegmento(ORG, seg({ fields: [tentativa as never] }))).toThrow(/chave de campo inválida/);
  });
});

describe("a organização vem primeiro e nenhum grupo a alarga", () => {
  it("é o primeiro filtro, mesmo sem critério nenhum", () => {
    expect(filtrosDoSegmento(ORG, null)[0]).toEqual({ metodo: "eq", coluna: "organization_id", valor: ORG });
  });

  it("nenhum `or()` menciona organization_id — o grupo OU fica preso DENTRO da organização", () => {
    const f = filtrosDoSegmento(ORG, seg({ tags_any: ["a"], fields_any: [{ key: "x", op: "neq", value: "y" }] }));
    for (const o of porMetodo(f, "or")) expect((o as { expressao: string }).expressao).not.toMatch(/organization_id/);
    expect(porMetodo(f, "eq").filter((x) => (x as { coluna: string }).coluna === "organization_id")).toHaveLength(1);
  });

  it("as exclusões fixas continuam (bloqueado, anonimizado, mesclado, sem telefone)", () => {
    const f = filtrosDoSegmento(ORG, seg({ tags_all: ["vip"] }));
    expect(f.slice(0, 5)).toEqual([
      { metodo: "eq", coluna: "organization_id", valor: ORG },
      { metodo: "eq", coluna: "is_blocked", valor: false },
      { metodo: "eq", coluna: "is_anonymized", valor: false },
      { metodo: "is", coluna: "is_merged_into" },
      { metodo: "not", coluna: "phone_number", operador: "is", valor: null },
    ]);
  });
});

describe("E, OU e NÃO", () => {
  it("E: etiquetas com `cs` (todas) e cada campo como filtro próprio", () => {
    const f = filtrosDoSegmento(ORG, seg({ tags_all: ["vip", "cliente"], fields: [{ key: "plano", op: "eq", value: "premium" }] }));
    expect(porMetodo(f, "contains")).toEqual([{ metodo: "contains", coluna: "tags", valor: '{"vip","cliente"}' }]);
    expect(f).toContainEqual({ metodo: "eq", coluna: "custom_fields->>plano", valor: "premium" });
  });

  it("OU: etiquetas (`ov`) e campos num ÚNICO or()", () => {
    const f = filtrosDoSegmento(
      ORG,
      seg({ tags_any: ["lead", "interessado"], fields_any: [{ key: "cidade", op: "contains", value: "Bras" }] }),
    );
    expect(porMetodo(f, "or")).toEqual([
      {
        metodo: "or",
        expressao: 'tags.ov."{\\"lead\\",\\"interessado\\"}",custom_fields->>cidade.imatch."Bras"',
      },
    ]);
  });

  it("NÃO: etiquetas com `not ov` e cada campo NEGADO dentro do vocabulário", () => {
    const f = filtrosDoSegmento(
      ORG,
      seg({
        tags_none: ["bloqueado"],
        fields_none: [
          { key: "plano", op: "eq", value: "free" },
          { key: "origem", op: "set", value: "" },
        ],
      }),
    );
    expect(porMetodo(f, "not")).toContainEqual({ metodo: "not", coluna: "tags", operador: "ov", valor: '{"bloqueado"}' });
    // NÃO (plano = free) → plano ≠ free OU plano vazio.
    expect(porMetodo(f, "or")).toContainEqual({
      metodo: "or",
      expressao: 'custom_fields->>plano.neq."free",custom_fields->>plano.is.null',
    });
    // NÃO (origem preenchida) → origem vazia.
    expect(f).toContainEqual({ metodo: "is", coluna: "custom_fields->>origem" });
  });

  it("tags + campos nos três grupos compõem uma expressão só, na ordem E → OU → NÃO", () => {
    const s = seg({
      tags_all: ["cliente"],
      fields: [{ key: "plano", op: "eq", value: "premium" }],
      tags_any: ["vip"],
      fields_any: [{ key: "cidade", op: "eq", value: "Brasília" }],
      tags_none: ["cancelado"],
    });
    expect(expressaoDoSegmento(s)).toEqual([
      'TODAS: tem "cliente" E plano = "premium"',
      'PELO MENOS UMA: tem "vip" OU cidade = "Brasília"',
      'NENHUMA: tem "cancelado"',
    ]);
  });
});

/** Um builder dublê que só registra o que foi pendurado nele. */
function builderQueGrava() {
  const chamadas: Array<[string, unknown[]]> = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "or", "filter", "contains", "overlaps", "order", "range"]) {
    q[m] = (...args: unknown[]) => {
      chamadas.push([m, args]);
      return q;
    };
  }
  q.then = (ok: (r: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(ok);
  return { db: { from: () => q } as never, chamadas };
}

describe("contagem e listagem são a MESMA expressão", () => {
  it("penduram exatamente os mesmos filtros, na mesma ordem", async () => {
    const s = seg({
      tags_all: ["Cliente, VIP"],
      tags_any: ["lead"],
      fields_any: [{ key: "cidade", op: "contains", value: "50%" }],
      tags_none: ["x"],
      fields_none: [{ key: "plano", op: "neq", value: "a,b" }],
    });
    const c = builderQueGrava();
    const l = builderQueGrava();
    await contarPublico(c.db, ORG, s);
    await listarPublico(l.db, ORG, s, { limite: 10, offset: 0 });
    const filtros = (ch: Array<[string, unknown[]]>) => ch.filter(([m]) => !["select", "order", "range"].includes(m));
    expect(filtros(c.chamadas)).toEqual(filtros(l.chamadas));
    expect(filtros(c.chamadas).length).toBe(filtrosDoSegmento(ORG, s).length);
  });
});

describe("compatibilidade: segmento gravado antes dos grupos novos", () => {
  it("lê com os grupos novos vazios e gera os mesmos filtros de antes", () => {
    const antigo = { tags_all: ["vip"], tags_any: ["a", "b"], tags_none: ["c"], fields: [{ key: "plano", op: "eq", value: "p" }] };
    const lido = segmentoSchema.parse(antigo);
    expect(lido.fields_any).toEqual([]);
    expect(lido.fields_none).toEqual([]);
    const f = filtrosDoSegmento(ORG, lido);
    expect(porMetodo(f, "or")).toEqual([{ metodo: "or", expressao: 'tags.ov."{\\"a\\",\\"b\\"}"' }]);
    expect(f).toContainEqual({ metodo: "eq", coluna: "custom_fields->>plano", valor: "p" });
  });
});
