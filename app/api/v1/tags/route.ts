/**
 * GET  /api/v1/tags — o REGISTRO de etiquetas da organização, com id.
 * POST /api/v1/tags — cria uma etiqueta antes do primeiro uso.
 *
 * ── Por que esta rota existe, se `/tags/vocabulario` já lista ────────────────
 *
 * São perguntas diferentes, e a diferença é o ponto da fatia. `/vocabulario`
 * responde "quais nomes JÁ foram escritos por alguém, e onde" — é derivado, e
 * por isso não tem id: um nome que ninguém aplicou não existe lá. Esta responde
 * "quais etiquetas a organização DECLAROU", com uuid estável e pasta. É a que
 * uma integração (N8N, script próprio) consulta, porque é a única em que o
 * identificador sobrevive a uma renomeação. A cor não mora aqui: é do
 * vocabulário, e a leitura dela é `GET /api/v1/tags/cores`.
 *
 * A etiqueta APLICADA continua sendo string em `contacts.tags` — ver o
 * cabeçalho da migration 0383 e a doutrina de `lib/schemas/tags.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarTagSchema, type TagDoRegistro } from "@/lib/schemas/tags";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, folder, archived_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // `agent`, e não `manager`: LER o vocabulário é o que o seletor de tags do
  // Inbox e o painel do flow precisam, e quem atende usa os dois. Escrever
  // continua sendo manager+ (abaixo) — é lá que está a consequência.
  const authz = await requireRole("agent", { requestId, resource: "settings_tags" });
  if (!authz.ok) return authz.response;

  const incluirArquivadas = req.nextUrl.searchParams.get("arquivadas") === "1";
  const supabase = await createClient();
  let query = supabase
    .from("tags")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("folder", { ascending: true })
    .order("name", { ascending: true });
  if (!incluirArquivadas) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const tags = (data ?? []) as unknown as TagDoRegistro[];
  return ok(tags, {
    requestId,
    meta: {
      total: tags.length,
      // As pastas existentes, para a tela oferecer sem inventar uma segunda
      // lista — pasta aqui é texto livre, então o conjunto é derivado.
      pastas: [...new Set(tags.map((t) => t.folder))].sort(),
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = criarTagSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira o nome da etiqueta.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tags")
    .insert({
      organization_id: authz.org.orgId,
      created_by_user_id: authz.user.id,
      name: parsed.data.name,
      folder: parsed.data.folder,
    })
    .select(COLUNAS)
    .single();

  if (error) {
    // 23505 = o índice único por nome canônico. Não é erro do sistema: é o
    // operador criando de novo o que já existe, e a mensagem tem de dizer isso.
    if (error.code === "23505")
      return fail("conflict", "Já existe uma etiqueta com esse nome.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "tag.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "tag",
    resourceId: (data as unknown as TagDoRegistro).id,
    requestId,
    metadata: { name: parsed.data.name, folder: parsed.data.folder },
  });

  return ok(data as unknown as TagDoRegistro, { requestId, status: 201 });
}
