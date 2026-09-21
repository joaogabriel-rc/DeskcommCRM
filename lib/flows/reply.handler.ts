/**
 * Resposta de botão — consome `message.received` (emitido por
 * fn_emit_message_event, AFTER INSERT em messages) ANTES do handler de IA
 * (mesma razão de `followupReactivityHandler`: no Hobby o drain estoura no
 * worker de IA e a resposta nunca é lida). Se houver uma flow_execution
 * esperando resposta de botão para este contato, tenta casar; sem match,
 * fica esperando (não força avanço às cegas).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import type { FlowExecutionRow } from "@/lib/flows/types";
import { resumeWithButtonReply } from "@/lib/flows/engine";
import { createAdminClient } from "@/lib/supabase/admin";

export const FLOW_REPLY_HANDLER_KEY = "flow-reply.v1";

export const flowReplyHandler: EventHandler = {
  key: FLOW_REPLY_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
    if (!contactId) return { consumer_key: FLOW_REPLY_HANDLER_KEY, status: "skipped", detail: "no_contact" };
    const text = typeof row.payload.body_preview === "string" ? row.payload.body_preview.trim() : "";
    if (!text) return { consumer_key: FLOW_REPLY_HANDLER_KEY, status: "skipped", detail: "no_text" };

    const admin = createAdminClient();
    const { data: execution, error } = await admin
      .from("flow_executions")
      .select("*")
      .eq("organization_id", row.organization_id)
      .eq("contact_id", contactId)
      .eq("status", "waiting")
      .eq("waiting_for", "button_reply")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { consumer_key: FLOW_REPLY_HANDLER_KEY, status: "error", detail: error.message };
    if (!execution) return { consumer_key: FLOW_REPLY_HANDLER_KEY, status: "skipped", detail: "no_execution" };

    const result = await resumeWithButtonReply(admin, execution as FlowExecutionRow, text);
    return {
      consumer_key: FLOW_REPLY_HANDLER_KEY,
      status: result.matched ? "ok" : "skipped",
      detail: result.matched ? "resumed" : "no_match",
    };
  },
};
