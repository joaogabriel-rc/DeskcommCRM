/**
 * Ações de CONVERSA do flow: `mark_conversation_open` e `assign_conversation`.
 *
 * ═══ Por que atribuir passa pela RPC, e abrir não ═══
 *
 * `assign_conversation` chama `fn_conversation_assign` — a MESMA função que o
 * Inbox, o MCP e o roteador usam. Ela grava o responsável E o evento de
 * atribuição na mesma transação; um UPDATE cru aqui gravaria a coluna e
 * deixaria a Fila e a timeline sem saber (o comentário da 0031/0032 diz isso
 * em voz alta). Já `status` é coluna simples, sem evento pareado.
 *
 * A conversa alvo é a do `serviceBoundary` do próprio flow — a mesma por onde
 * as mensagens dele saem. Sem boundary resolvido (flow que nunca mandou nada),
 * cai na conversa mais recente do contato.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function conversaDoContato(ctx: ActionCtx): Promise<string | null> {
  const contact = ctx.context.contact as { id?: string } | undefined;
  if (!contact?.id) return null;
  const { data } = await ctx.admin
    .from("conversations")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contact.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

async function marcarAberta(ctx: ActionCtx): Promise<ActionResultDetail> {
  const conversationId = await conversaDoContato(ctx);
  if (!conversationId) {
    return { type: "mark_conversation_open", status: "skipped", detail: { reason: "no_conversation" } };
  }
  const { error } = await ctx.admin
    .from("conversations")
    .update({ status: "open", status_changed_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "mark_conversation_open", status: "failed", error: error.message };
  return { type: "mark_conversation_open", status: "success", detail: { conversation_id: conversationId } };
}

async function atribuir(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const userId = typeof config.user_id === "string" ? config.user_id : null;
  if (!userId) return { type: "assign_conversation", status: "failed", error: "missing_user_id" };
  const conversationId = await conversaDoContato(ctx);
  if (!conversationId) {
    return { type: "assign_conversation", status: "skipped", detail: { reason: "no_conversation" } };
  }

  const { error } = await ctx.admin.rpc("fn_conversation_assign", {
    p_conversation_id: conversationId,
    p_organization_id: ctx.organizationId,
    p_reason: "flow",
    p_to_user_id: userId,
  });
  if (error) return { type: "assign_conversation", status: "failed", error: error.message };
  return {
    type: "assign_conversation",
    status: "success",
    detail: { conversation_id: conversationId, user_id: userId },
  };
}

registerAction({ type: "mark_conversation_open", execute: (ctx) => marcarAberta(ctx) });
registerAction({ type: "assign_conversation", execute: (ctx, config) => atribuir(ctx, config) });
