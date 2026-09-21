/**
 * O DISPARO — qualquer gatilho do catálogo, não só tag.
 *
 * Assina TODOS os `event_type` que o catálogo (`lib/flows/triggers.ts`)
 * declara, e para cada evento pergunta: quais flows ATIVOS desta organização
 * escutam este gatilho, e a configuração deles casa com este evento? N flows
 * podem casar — e os N rodam, como já acontece na automação de `event_log`.
 *
 * O contato sai da entidade do evento: direto (`contact`), pelo negócio
 * (`crm_lead`/`lead`), pelo agendamento (`calendar_appointment`) ou pelo
 * payload da mensagem. Sem contato não há execução — um flow conversa com
 * alguém.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { startFlowExecution } from "@/lib/flows/engine";
import { EVENTOS_DE_GATILHO, eventoAcionaGatilho } from "@/lib/flows/triggers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const FLOW_TAG_TRIGGER_HANDLER_KEY = "flow-trigger.v1";

/**
 * De onde sai o contato de cada entidade de evento.
 *
 * `lead` e `crm_lead` convivem de propósito: o trigger legado do banco
 * (`fn_emit_event_on_lead_change`) deriva `entity_kind` do prefixo do
 * `event_type` e emite `lead`, enquanto os handlers de aplicação emitem
 * `crm_lead`. Tratar só um dos dois faria metade dos gatilhos de funil não
 * disparar — calados, que é o pior desfecho (o cabeçalho de
 * `lib/automation/engine.ts` descreve o mesmo par).
 */
async function contatoDoEvento(admin: SupabaseClient, row: EventRow): Promise<string | null> {
  const doPayload = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
  if (doPayload) return doPayload;

  if (row.entity_kind === "contact") return row.entity_id;

  if ((row.entity_kind === "crm_lead" || row.entity_kind === "lead") && row.entity_id) {
    const { data } = await admin
      .from("crm_leads")
      .select("contact_id")
      .eq("id", row.entity_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    return (data as { contact_id?: string | null } | null)?.contact_id ?? null;
  }

  if (row.entity_kind === "calendar_appointment" && row.entity_id) {
    const { data } = await admin
      .from("calendar_appointments")
      .select("contact_id")
      .eq("id", row.entity_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    return (data as { contact_id?: string | null } | null)?.contact_id ?? null;
  }

  return null;
}

export const flowTagTriggerHandler: EventHandler = {
  key: FLOW_TAG_TRIGGER_HANDLER_KEY,
  events: EVENTOS_DE_GATILHO,
  async handle(row): Promise<HandlerResult> {
    const admin = createAdminClient();

    const { data: flows, error } = await admin
      .from("flows")
      .select("id, name, trigger_type, trigger_config")
      .eq("organization_id", row.organization_id)
      .eq("status", "active");
    if (error) return { consumer_key: FLOW_TAG_TRIGGER_HANDLER_KEY, status: "error", detail: error.message };

    const candidatos = (flows ?? []).filter((f) =>
      eventoAcionaGatilho(
        String(f.trigger_type),
        (f.trigger_config as Record<string, unknown> | null) ?? {},
        row,
      ),
    );
    // A leitura do contato custa uma consulta; só vale a pena se algum flow casou.
    if (!candidatos.length) return { consumer_key: FLOW_TAG_TRIGGER_HANDLER_KEY, status: "ok", detail: "no_flow" };

    const contactId = await contatoDoEvento(admin, row);
    if (!contactId) return { consumer_key: FLOW_TAG_TRIGGER_HANDLER_KEY, status: "skipped", detail: "no_contact" };

    for (const flow of candidatos) {
      const result = await startFlowExecution(admin, {
        organizationId: row.organization_id,
        flowId: flow.id as string,
        contactId,
        triggerEventId: row.id,
      });
      if (!result.ok && result.reason !== "already_active") {
        logger.error("[flows.trigger] startFlowExecution failed", {
          flow_id: flow.id,
          contact_id: contactId,
          reason: result.reason,
        });
      }
    }
    return { consumer_key: FLOW_TAG_TRIGGER_HANDLER_KEY, status: "ok", detail: `flows=${candidatos.length}` };
  },
};
