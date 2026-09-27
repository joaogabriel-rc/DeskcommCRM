/**
 * Consumidor de `meta.historico.chunk_guardado` — roda o resolvedor da janela
 * (organização, canal, onboarding) que o evento nomeia.
 *
 * A organização é a da linha do `event_log`, escrita pelo servidor; o canal e o
 * onboarding vêm do payload que o próprio servidor emitiu. Janela sem eco em
 * espera sai barata: a função de correlação devolve vazio sem ler o history, e
 * não há o que promover.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { EVENTO_CHUNK_GUARDADO } from "./ecos-em-espera";
import { resolverEcosEmEspera } from "./resolver-ecos-em-espera";

export const ECOS_EM_ESPERA_CONSUMER_KEY = "meta_ecos_em_espera";

export async function resolverEcosDoEvento(row: EventRow): Promise<HandlerResult> {
  const channelSessionId = row.payload?.channel_session_id;
  const onboardingEm = row.payload?.onboarding_em;
  if (typeof channelSessionId !== "string" || typeof onboardingEm !== "string") {
    return { consumer_key: ECOS_EM_ESPERA_CONSUMER_KEY, status: "skipped", detail: "sem janela no payload" };
  }
  try {
    const r = await resolverEcosEmEspera(createAdminClient(), {
      organizationId: row.organization_id,
      channelSessionId,
      onboardingEm,
    });
    return {
      consumer_key: ECOS_EM_ESPERA_CONSUMER_KEY,
      status: "ok",
      detail: `historico=${r.historico} promovidos=${r.promovidos} duplicados=${r.duplicados} aguardando=${r.aguardando} falhas=${r.falhas}`,
    };
  } catch (err) {
    return {
      consumer_key: ECOS_EM_ESPERA_CONSUMER_KEY,
      status: "error",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }
}

export const ecosEmEsperaHandler: EventHandler = {
  key: ECOS_EM_ESPERA_CONSUMER_KEY,
  events: [EVENTO_CHUNK_GUARDADO],
  handle: resolverEcosDoEvento,
};
