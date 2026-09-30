import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * SÓ O IMPORTADOR DE HISTORY TRANSFORMA `media_placeholder` EM MENSAGEM (0496).
 *
 * No history da sincronização do app, a mídia vem como `media_placeholder` — sem
 * a mídia — e a mídia chega depois, por outro webhook, com o MESMO wamid. Quem
 * ler o placeholder para criar mensagem fora do importador cria a mensagem
 * histórica por um segundo caminho, e o wamid nasce duas vezes (ou nasce com
 * efeitos de mensagem nova: IA, distribuição, pausa).
 *
 * Hoje o importador não existe, então a allowlist de TypeScript é VAZIA: nenhum
 * literal `"media_placeholder"` em código de produto. No SQL, a única leitura é a
 * `fn_meta_ecos_correlacionar`, que só marca estado na quarentena. A allowlist só
 * encolhe — o importador, quando nascer, entra aqui com a razão escrita.
 *
 * Ancorado no AST: comentário que CITA o termo não é uso, e este repositório
 * explica o que faz em prosa o tempo todo.
 */

const RAIZ = join(__dirname, "..", "..");
const PASTAS = ["lib", "app", "workers", "components", "hooks"];
const TERMO = "media_placeholder";

/** Arquivos de produto que podem ler o placeholder como dado. Vazia de propósito. */
const ALLOWLIST_TS: ReadonlyArray<{ arquivo: string; razao: string }> = [];

function arquivos(pasta: string): string[] {
  const saida: string[] = [];
  const andar = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) andar(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) saida.push(p);
    }
  };
  andar(pasta);
  return saida;
}

/** Literais de string/template que contêm o termo, no fonte dado. */
export function literaisComOTermo(fonte: string, nome: string): number[] {
  const arq = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  const linhas: number[] = [];
  const visitar = (no: ts.Node): void => {
    if ((ts.isStringLiteralLike(no) || ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) && no.text.includes(TERMO)) {
      linhas.push(arq.getLineAndCharacterOfPosition(no.getStart()).line + 1);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arq);
  return linhas;
}

describe("media_placeholder só no importador de history", () => {
  it("o instrumento acusa um literal e ignora comentário (controles)", () => {
    expect(literaisComOTermo(`const t = "media_placeholder";`, "a.ts")).toEqual([1]);
    expect(literaisComOTermo(`// media_placeholder é citado aqui\nconst x = 1;`, "b.ts")).toEqual([]);
  });

  it("nenhum código de produto fora da allowlist lê o placeholder como dado", () => {
    const permitidos = new Set(ALLOWLIST_TS.map((a) => a.arquivo));
    const infratores: string[] = [];
    for (const pasta of PASTAS) {
      for (const p of arquivos(join(RAIZ, pasta))) {
        const rel = relative(RAIZ, p);
        if (permitidos.has(rel)) continue;
        const achados = literaisComOTermo(readFileSync(p, "utf8"), rel);
        if (achados.length > 0) infratores.push(`${rel}:${achados.join(",")}`);
      }
    }
    expect(infratores, "placeholder lido fora do importador de history").toEqual([]);
  });

  it("no SQL, só a fn_meta_ecos_correlacionar lê o placeholder — e ela não escreve em messages", () => {
    const fontes = [
      "supabase/baseline.sql",
      ...readdirSync(join(RAIZ, "supabase", "migrations"))
        .filter((f) => f.endsWith(".sql"))
        .map((f) => `supabase/migrations/${f}`),
    ];
    const foraDaFuncao: string[] = [];
    let corpos = 0;
    for (const f of fontes) {
      const s = readFileSync(join(RAIZ, f), "utf8");
      let i = s.indexOf(TERMO);
      while (i >= 0) {
        const inicio = s.lastIndexOf("create or replace function public.", i);
        const cabecalho = inicio >= 0 ? s.slice(inicio, s.indexOf("(", inicio)) : "";
        const fim = inicio >= 0 ? s.indexOf("$$;", inicio) : -1;
        const dentro = cabecalho.endsWith("fn_meta_ecos_correlacionar") && fim > i;
        if (!dentro) {
          // Comentário SQL, ou o `comment on function` da própria função, citando o
          // termo não é leitura.
          const linha = s.slice(s.lastIndexOf("\n", i) + 1, s.indexOf("\n", i));
          const comando = s.slice(s.lastIndexOf(";", i) + 1, i);
          const documentacao = /comment\s+on\s+function\s+public\.fn_meta_ecos_correlacionar/i.test(comando);
          if (!linha.trimStart().startsWith("--") && !documentacao) foraDaFuncao.push(`${f}@${i}`);
        } else {
          corpos += 1;
          expect(s.slice(inicio, fim)).not.toMatch(/insert\s+into\s+public\.messages/i);
        }
        i = s.indexOf(TERMO, i + TERMO.length);
      }
    }
    expect(foraDaFuncao).toEqual([]);
    expect(corpos, "a função da 0496 existe na migration e no baseline").toBeGreaterThanOrEqual(2);
  });
});
