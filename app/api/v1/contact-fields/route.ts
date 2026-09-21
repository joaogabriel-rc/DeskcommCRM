/**
 * GET  /api/v1/contact-fields — o REGISTRO de campos do contato, com id.
 * POST /api/v1/contact-fields — declara um campo novo.
 *
 * É a lista que o nó ACTION do flow, o editor de mensagem, o construtor de
 * segmento dos disparos e o N8N consultam. Antes desta rota, "qual campo existe
 * nesta organização?" não tinha resposta: a definição morava em
 * `crm_pipelines.settings.fields[]` (do FUNIL) e o valor em
 * `contacts.custom_fields`, sem nada ligando os dois.
 *
 * ⚠️ `key` é aceita só aqui, na criação. Ver `lib/schemas/contact-fields.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarCampoSchema, type CampoDoContato } from "@/lib/schemas/contact-fields";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, key, label, description, type, options, folder, archived_at, position";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // `agent` para LER, pelo mesmo motivo de `/api/v1/tags`: o dossiê do contato
  // e o painel do flow precisam da lista, e quem atende abre os dois.
  const authz = await requireRole("agent", { requestId, resource: "settings_contact_fields" });
  if (!authz.ok) return authz.response;

  const incluirArquivados = req.nextUrl.searchParams.get("arquivados") === "1";
  const supabase = await createClient();
  let query = supabase
    .from("contact_fields")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("folder", { ascending: true })
    .order("position", { ascending: true })
    .order("label", { ascending: true });
  if (!incluirArquivados) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const campos = (data ?? []) as unknown as CampoDoContato[];
  return ok(campos, {
    requestId,
    meta: {
      total: campos.length,
      pastas: [...new Set(campos.map((c) => c.folder))].sort(),
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_contact_fields" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = criarCampoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira o nome e a chave do campo.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_fields")
    .insert({
      organization_id: authz.org.orgId,
      created_by_user_id: authz.user.id,
      key: parsed.data.key,
      label: parsed.data.label,
      description: parsed.data.description ?? null,
      type: parsed.data.type,
      options: parsed.data.options,
      folder: parsed.data.folder,
    })
    .select(COLUNAS)
    .single();

  if (error) {
    if (error.code === "23505")
      return fail("conflict", "Já existe um campo com essa chave.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "contact_field.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact_field",
    resourceId: (data as unknown as CampoDoContato).id,
    requestId,
    metadata: { key: parsed.data.key, label: parsed.data.label, type: parsed.data.type },
  });

  return ok(data as unknown as CampoDoContato, { requestId, status: 201 });
}
