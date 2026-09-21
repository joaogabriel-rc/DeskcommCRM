/**
 * Ação `update_custom_field` — grava UM campo em `custom_fields` (jsonb) do
 * LEAD do contexto (ou do CONTATO, se não houver lead). Mesmo padrão de
 * merge não-destrutivo de `add_tag`: só a chave pedida muda, o resto do jsonb
 * sobrevive.
 */
import { registerAction } from "@/lib/automation/actions";
import { renderTemplate } from "@/lib/automation/template";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const field = typeof config.field === "string" ? config.field.trim() : "";
  if (!field) return { type: "update_custom_field", status: "failed", error: "missing_field" };
  // O valor aceita VARIÁVEL, e não só literal: "Olá {{contact.name}}" gravado
  // num campo é o que permite montar a frase uma vez na ação e reusá-la na
  // mensagem. Mesmo resolvedor de `{{...}}` que o corpo da mensagem usa — dois
  // resolvedores fariam a mesma chave render diferente em dois lugares.
  //
  // Só texto passa pelo render: um número, um booleano ou um objeto vindo da
  // API não têm `{{}}` e converter para string mudaria o TIPO do que está
  // gravado, quebrando condição e segmentação que comparam número.
  const bruto = config.value ?? null;
  const value =
    typeof bruto === "string" && bruto.includes("{{") ? renderTemplate(bruto, ctx.context) : bruto;

  const lead = ctx.context.lead as { id: string; custom_fields?: Record<string, unknown> } | undefined;
  const contact = ctx.context.contact as { id: string; custom_fields?: Record<string, unknown> } | undefined;
  const target = lead
    ? { table: "crm_leads", row: lead }
    : contact
      ? { table: "contacts", row: contact }
      : null;
  if (!target) return { type: "update_custom_field", status: "skipped", detail: { reason: "no_target" } };

  const merged = { ...(target.row.custom_fields ?? {}), [field]: value };
  const { error } = await ctx.admin
    .from(target.table)
    .update({ custom_fields: merged, updated_at: new Date().toISOString() })
    .eq("id", target.row.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "update_custom_field", status: "failed", error: error.message };

  // Ações seguintes do MESMO nó ACTION (ou nós depois) enxergam o valor novo —
  // mesma razão de `create-or-move-lead.ts` publicar no contexto.
  if (lead) ctx.context.lead = { ...lead, custom_fields: merged };
  else if (contact) ctx.context.contact = { ...contact, custom_fields: merged };

  return { type: "update_custom_field", status: "success", detail: { field, value } };
}

registerAction({ type: "update_custom_field", execute });
