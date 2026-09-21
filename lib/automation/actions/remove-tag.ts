/**
 * Ação `remove_tag` — irmã de `add_tag`: remove tags do LEAD do contexto (ou
 * do CONTATO, se não houver lead). Não emite evento próprio — diferente de
 * `add_tag`, tirar uma tag não é gatilho de nada hoje; se algum consumidor
 * precisar de `contact.tag_removed` no futuro, entra junto com o consumidor.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "remove_tag", status: "skipped", detail: { reason: "no_tags" } };

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;
  const target = lead
    ? { table: "crm_leads", row: lead }
    : contact
      ? { table: "contacts", row: contact }
      : null;
  if (!target) return { type: "remove_tag", status: "skipped", detail: { reason: "no_target" } };

  const prev = target.row.tags ?? [];
  const remaining = prev.filter((t) => !tags.includes(t));
  if (remaining.length === prev.length) {
    return { type: "remove_tag", status: "success", detail: { removed: [] } };
  }

  const { error } = await ctx.admin
    .from(target.table)
    .update({ tags: remaining, updated_at: new Date().toISOString() })
    .eq("id", target.row.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "remove_tag", status: "failed", error: error.message };
  return { type: "remove_tag", status: "success", detail: { removed: tags } };
}

registerAction({ type: "remove_tag", execute });
