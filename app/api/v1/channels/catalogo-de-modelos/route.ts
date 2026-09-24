/**
 * GET /api/v1/channels/catalogo-de-modelos — os modelos aprovados que uma tela
 * pode OFERECER, e as conexões que têm catálogo.
 *
 * Só leitura, papel `manager`: é quem monta fluxo (e, depois, disparo). A rota
 * de Conexões (`/channels/templates`) continua `admin`, porque ela também
 * sincroniza e grava o link salvo — aqui não há escrita nenhuma.
 *
 * Query (opcional):
 *   channel_session_id  recorta os modelos da conta desta conexão. Conexão de
 *                       outra organização devolve lista vazia, nunca a lista
 *                       da organização inteira.
 *   todos=1             inclui os não aprovados (para mostrar o estado de um
 *                       modelo já escolhido que deixou de ser utilizável).
 *
 * A organização vem da sessão (`requireRole`), nunca da query. A leitura usa o
 * client da SESSÃO: a RLS de `meta_templates` e de `channel_sessions` recorta
 * a organização, e o filtro explícito de `organization_id` vem por cima.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { conexoesComModelos, listarModelos } from "@/lib/channels/catalogo-de-modelos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const consultaSchema = z.object({
  channel_session_id: z.string().uuid().optional(),
  todos: z.enum(["0", "1"]).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_template_catalog" });
  if (!authz.ok) return authz.response;

  const parsed = consultaSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return fail("invalid_request", "Parâmetros inválidos.", 400, { requestId, details: parsed.error.flatten() });
  }

  const supabase = await createClient();
  try {
    const [conexoes, modelos] = await Promise.all([
      conexoesComModelos(supabase, authz.org.orgId),
      listarModelos(supabase, {
        organizationId: authz.org.orgId,
        channelSessionId: parsed.data.channel_session_id ?? null,
        somenteUtilizaveis: parsed.data.todos !== "1",
      }),
    ]);
    return ok({ conexoes, modelos }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "catalog_failed", 500, { requestId });
  }
}
