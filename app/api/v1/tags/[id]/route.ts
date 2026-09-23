/**
 * PATCH  /api/v1/tags/[id] — edita uma etiqueta do registro.
 * DELETE /api/v1/tags/[id] — tira a etiqueta do registro.
 *
 * ── Renomear é DUAS operações, e essa é a parte delicada ─────────────────────
 *
 * O nome de uma etiqueta É o valor aplicado: ele está gravado dentro de
 * `contacts.tags`, `crm_leads.tags`, `conversations.tags` e nas regras `add_tag`
 * dos agentes. Trocar só a linha do registro deixaria o registro dizendo "VIP
 * Ouro" enquanto 300 contatos continuam marcados "VIP" — duas verdades sobre o
 * mesmo fato.
 *
 * Por isso o rename vai primeiro por `fn_vocabulario_de_tags_operar` (0264),
 * que reescreve tudo isso numa transação só, e só depois sincroniza o registro
 * por `fn_tag_registro_aplicar` (0389), PRESERVANDO o id. É o inverso do que a
 * intuição sugere (mexer no registro primeiro), e é o que garante que o id
 * sobreviva: quem guardou o uuid continua apontando para a mesma etiqueta.
 *
 * Pasta e arquivamento são METADADO do registro — não estão gravados em lugar
 * nenhum além daqui — e vão direto no UPDATE. Cor e descrição NÃO: são do
 * vocabulário (`organizations.settings.tags[]`, migration 0336), e quem as grava
 * é `POST /api/v1/tags/vocabulario` com `definir_cor`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarTagSchema, type TagDoRegistro } from "@/lib/schemas/tags";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, folder, archived_at";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const parsed = atualizarTagSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados da etiqueta.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("tags")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Etiqueta não encontrada.", 404, { requestId });

  const anterior = atual as unknown as TagDoRegistro;
  const novoNome = parsed.data.name?.trim();
  const renomeou = !!novoNome && novoNome.toLowerCase() !== anterior.name.toLowerCase();

  if (renomeou) {
    // UMA chamada, UMA transação: `fn_tag_operar` (0389) chama o rename do
    // vocabulário (contatos, negócios, conversas e as regras `add_tag` dos
    // agentes) e o do registro no mesmo corpo. Se o segundo levantar, o
    // primeiro volta atrás junto — a versão anterior fazia duas chamadas, e
    // entre elas existia uma janela com o vocabulário renomeado e o registro
    // ainda no nome velho.
    const { error: opErr } = await supabase.rpc("fn_tag_operar", {
      p_org: authz.org.orgId,
      p_acao: "renomear",
      p_tag: anterior.name,
      p_destino: novoNome!,
      p_cor: null,
    });
    if (opErr) {
      if (opErr.code === "42501")
        return fail("forbidden", "Esta sessão não pode mudar as etiquetas da organização.", 403, { requestId });
      if (opErr.code === "22023")
        return fail("validation_failed", "Confira o nome da etiqueta.", 422, { requestId });
      // 23505 = o índice único do registro. Acontece ao renomear PARA um nome
      // que já está declarado, e agora a transação inteira volta atrás — sem o
      // invólucro, as etiquetas aplicadas ficavam renomeadas e o registro não.
      // É conflito do operador, não falha do sistema: 409, com a frase certa.
      if (opErr.code === "23505")
        return fail(
          "conflict",
          "Já existe uma etiqueta com esse nome. Para unir as duas, use a operação Juntar.",
          409,
          { requestId },
        );
      return fail("internal_error", opErr.message, 500, { requestId });
    }
  }

  // O metadado, e só o metadado. `name` fica de fora: quem o escreveu foi o
  // bloco acima, e repeti-lo aqui poderia desfazer a normalização do banco.
  // Cor e descrição também: são do vocabulário (`settings.tags[]`), e quem as
  // grava é `POST /api/v1/tags/vocabulario` com `definir_cor`.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.folder !== undefined) patch.folder = parsed.data.folder;
  if (parsed.data.archived !== undefined)
    patch.archived_at = parsed.data.archived ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from("tags")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS)
    .single();
  if (error) {
    if (error.code === "23505")
      return fail("conflict", "Já existe uma etiqueta com esse nome.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "tag.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "tag",
    resourceId: id,
    requestId,
    metadata: { de: anterior.name, para: novoNome ?? anterior.name, renomeou },
  });

  return ok(data as unknown as TagDoRegistro, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("tags")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Etiqueta não encontrada.", 404, { requestId });

  // Só o REGISTRO sai. A etiqueta aplicada nos contatos continua onde está —
  // tirar do vocabulário é dizer "não ofereça mais", não "apague o histórico de
  // quem foi marcado". Quem quer a remoção em massa usa a ação "excluir" da
  // tela de vocabulário, que é explícita sobre quantas linhas vai tocar.
  const { error } = await supabase
    .from("tags")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "tag.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "tag",
    resourceId: id,
    requestId,
    metadata: { name: (atual as unknown as TagDoRegistro).name },
  });

  return ok({ id }, { requestId });
}
