/**
 * GET /api/v1/broadcasts/previa — quantas pessoas este segmento alcança agora.
 *
 * ── Por que GET com query, e não POST com corpo ─────────────────────────────
 *
 * Porque é LEITURA, e o produto tem um gate que mede isso: verbo mutante em
 * `/api/v1` exige `requireSupportWrite()` (`tests/unit/suporte-cobertura-de-efeitos.test.ts`).
 * A primeira versão desta prévia era um `PUT` na coleção — corpo mais confortável,
 * semântica errada — e o gate a reprovou com razão: a régua dele é o VERBO, e
 * afrouxá-la para acomodar uma leitura disfarçada abriria a porta para uma
 * escrita disfarçada depois.
 *
 * O preço é codificar o segmento na query. Ele é pequeno: listas repetem o
 * parâmetro (`?tag_all=vip&tag_all=obra`) e cada critério de campo vira um
 * `campo=<chave>:<operador>:<valor>`.
 *
 * ── A contagem sai da MESMA função que materializa ──────────────────────────
 *
 * `contarPublico` e `listarPublico` compartilham os filtros (`lib/disparos/segmento.ts`).
 * Fossem duas queries, a prévia diria 320 e sairiam 287 — e não haveria como
 * saber qual das duas estava certa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { contarPublico, expressaoDoSegmento, resumoDoSegmento } from "@/lib/disparos/segmento";
import { segmentoSchema, OPERADORES_DE_CAMPO, type OperadorDeCampo } from "@/lib/schemas/disparos";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;

  const q = req.nextUrl.searchParams;

  // A forma NOVA: o segmento inteiro, como JSON — o MESMO objeto que o editor
  // salva e que o agendamento materializa. Nada é retraduzido no caminho, então
  // a contagem mostrada é da expressão que vai ser usada (Rodada 2).
  const bruto = q.get("segmento");
  if (bruto !== null) {
    let json: unknown;
    try {
      json = JSON.parse(bruto);
    } catch {
      return fail("validation_failed", "Confira os critérios de público.", 422, { requestId });
    }
    const seg = segmentoSchema.safeParse(json);
    if (!seg.success) {
      return fail("validation_failed", "Confira os critérios de público.", 422, {
        requestId,
        details: seg.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { total, erro } = await contarPublico(supabase, authz.org.orgId, seg.data);
    if (erro) return fail("internal_error", erro, 500, { requestId });
    return ok(
      { total, resumo: resumoDoSegmento(seg.data), expressao: expressaoDoSegmento(seg.data) },
      { requestId },
    );
  }

  const campos = q.getAll("campo").map((bruto) => {
    // `split(":", 3)` NÃO serve: ele descarta o resto, e um valor com dois
    // pontos ("horario:14:30") perderia metade. O limite é nos DOIS primeiros
    // separadores; o que sobra é o valor inteiro.
    const primeiro = bruto.indexOf(":");
    const segundo = bruto.indexOf(":", primeiro + 1);
    const key = primeiro >= 0 ? bruto.slice(0, primeiro) : bruto;
    const op = segundo >= 0 ? bruto.slice(primeiro + 1, segundo) : "eq";
    const value = segundo >= 0 ? bruto.slice(segundo + 1) : "";
    return {
      key,
      op: (OPERADORES_DE_CAMPO as readonly string[]).includes(op) ? (op as OperadorDeCampo) : "eq",
      value,
    };
  });

  const parsed = segmentoSchema.safeParse({
    tags_all: q.getAll("tag_all"),
    tags_any: q.getAll("tag_any"),
    tags_none: q.getAll("tag_none"),
    fields: campos,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Confira os critérios de público.", 422, { requestId });
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { total, erro } = await contarPublico(supabase, authz.org.orgId, parsed.data);
  if (erro) return fail("internal_error", erro, 500, { requestId });

  return ok({ total, resumo: resumoDoSegmento(parsed.data) }, { requestId });
}
