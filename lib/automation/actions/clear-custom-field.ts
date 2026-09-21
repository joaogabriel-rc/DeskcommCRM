/**
 * Ação `clear_custom_field` — apaga UMA chave de `custom_fields` do LEAD do
 * contexto (ou do CONTATO, se não houver lead). Irmã de
 * `update_custom_field`: mesmo alvo, mesmo merge não-destrutivo do resto.
 *
 * Apagar a chave (e não gravar `null`) é a diferença que importa para quem lê
 * depois: `resolveField` devolve `undefined` para chave ausente, e o operador
 * que perguntar "o campo está vazio?" numa condição recebe a resposta certa.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const field = typeof config.field === "string" ? config.field.trim() : "";
  if (!field) return { type: "clear_custom_field", status: "failed", error: "missing_field" };

  const lead = ctx.context.lead as { id: string; custom_fields?: Record<string, unknown> } | undefined;
  const contact = ctx.context.contact as { id: string; custom_fields?: Record<string, unknown> } | undefined;
  const target = lead ? { table: "crm_leads", row: lead } : contact ? { table: "contacts", row: contact } : null;
  if (!target) return { type: "clear_custom_field", status: "skipped", detail: { reason: "no_target" } };

  const atual = { ...(target.row.custom_fields ?? {}) };
  if (!(field in atual)) return { type: "clear_custom_field", status: "success", detail: { field, já_vazio: true } };
  delete atual[field];

  const { error } = await ctx.admin
    .from(target.table)
    .update({ custom_fields: atual, updated_at: new Date().toISOString() })
    .eq("id", target.row.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "clear_custom_field", status: "failed", error: error.message };

  if (lead) ctx.context.lead = { ...lead, custom_fields: atual };
  else if (contact) ctx.context.contact = { ...contact, custom_fields: atual };

  return { type: "clear_custom_field", status: "success", detail: { field } };
}

registerAction({ type: "clear_custom_field", execute });
