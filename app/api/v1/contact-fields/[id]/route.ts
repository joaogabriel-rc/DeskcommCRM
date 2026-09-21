/**
 * PATCH  /api/v1/contact-fields/[id] — edita a DEFINIÇÃO de um campo.
 * DELETE /api/v1/contact-fields/[id] — tira o campo do registro.
 *
 * ── O que NÃO dá para editar, e por quê ─────────────────────────────────────
 *
 * A chave. `atualizarCampoSchema` nem a aceita. `contacts.custom_fields` é
 * indexado por ela, e `{{contact.custom_fields.<key>}}` está escrito dentro de
 * mensagens de flows publicados: mudar a chave renderizaria vazio em toda
 * mensagem que a cita, sem erro em lugar nenhum. O nome (`label`) muda à
 * vontade, e é ele que aparece na tela — é isto que dá o vínculo que sobrevive
 * à renomeação.
 *
 * ── Arquivar é diferente de excluir ─────────────────────────────────────────
 *
 * Arquivar tira o campo dos seletores e mantém o valor legível no contato.
 * Excluir tira a DEFINIÇÃO; o valor gravado em `custom_fields` continua lá,
 * porque apagá-lo seria perda de dado de cliente disparada por uma arrumação de
 * configuração.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarCampoSchema, type CampoDoContato } from "@/lib/schemas/contact-fields";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, key, label, description, type, options, folder, archived_at, position";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_contact_fields" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const parsed = atualizarCampoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados do campo.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description ?? null;
  if (parsed.data.type !== undefined) patch.type = parsed.data.type;
  if (parsed.data.options !== undefined) patch.options = parsed.data.options;
  if (parsed.data.folder !== undefined) patch.folder = parsed.data.folder;
  if (parsed.data.position !== undefined) patch.position = parsed.data.position;
  if (parsed.data.archived !== undefined)
    patch.archived_at = parsed.data.archived ? new Date().toISOString() : null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_fields")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Campo não encontrado.", 404, { requestId });

  void audit({
    action: "contact_field.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact_field",
    resourceId: id,
    requestId,
    metadata: { ...parsed.data },
  });

  return ok(data as unknown as CampoDoContato, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_contact_fields" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("contact_fields")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Campo não encontrado.", 404, { requestId });

  const { error } = await supabase
    .from("contact_fields")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "contact_field.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact_field",
    resourceId: id,
    requestId,
    metadata: { key: (atual as unknown as CampoDoContato).key },
  });

  return ok({ id }, { requestId });
}
