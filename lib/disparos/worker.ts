/**
 * O MOTOR DOS DISPAROS — envio em massa sem laço síncrono.
 *
 * ── A forma, e por que ela é esta ───────────────────────────────────────────
 *
 * Um tick faz três coisas e volta:
 *
 *   1. `fn_claim_due_broadcasts`   pega até N disparos vencidos, com lease.
 *   2. para cada um, `fn_claim_due_broadcast_recipients` pega um LOTE de
 *      destinatários pendentes, também com lease.
 *   3. manda o lote e reagenda o disparo para o próximo minuto.
 *
 * Duas camadas de claim porque são duas corridas diferentes: a de cima impede
 * dois workers pegando o mesmo disparo; a de baixo impede dois workers pegando
 * o mesmo destinatário se o lease de cima vencer no meio de um lote demorado.
 *
 * ── O ritmo não vem de `sleep` ──────────────────────────────────────────────
 *
 * A doutrina anti-banimento pede 1 mensagem a cada 5 segundos em campanha. A
 * tentação é dormir entre os envios; dormir dentro de um handler HTTP é o que
 * faz o cron estourar o timeout e o disparo parar sem ninguém saber. Em vez
 * disso o LOTE é o ritmo: `LOTE_POR_TICK` mensagens por tick, e o tick é de um
 * minuto (o cron). 12 por minuto é uma a cada cinco segundos, na média, sem
 * bloquear nada — e o `next_run_at` é quem guarda onde parou.
 *
 * ── A fronteira de serviço NÃO é criada aqui ────────────────────────────────
 *
 * Ela foi ancorada quando o operador AUTORIZOU o disparo (`fn_broadcast_materializar`,
 * migration 0389) e está gravada na linha do destinatário. O worker só
 * reconfere (`assertServiceBoundarySupabase`) e recusa se o mundo mudou. Um
 * tick que fabricasse autorização própria é exatamente o que
 * `beginServiceAtOrigin` proíbe — e com razão: retentativa não é consentimento
 * novo.
 *
 * ── Modo FLUXO (migration 0394): o mesmo lote, o mesmo ritmo ────────────────
 *
 * Quando o disparo tem um fluxo próprio (`flows.broadcast_id`), cada
 * destinatário do lote INICIA uma execução desse fluxo em vez de receber a
 * mensagem direto. Nada mais muda: o claim, o lote de 12 por tick e a
 * reconferência da permissão são os mesmos. A execução leva a permissão do
 * destinatário (`flow_executions.service_boundary`) e o motor de fluxos
 * (`lib/flows/engine.ts`) a entrega ao nó de mensagem, que a reconfere. Depois
 * de uma espera, quem retoma é o relógio que o motor JÁ tem (`flow-worker`); a
 * resposta a um botão, o handler de resposta que ele JÁ tem. Nenhum relógio novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";
import { startFlowExecution } from "@/lib/flows/engine";
import { renderFlowTemplate } from "@/lib/flows/template";
import { motivoDoErro } from "@/lib/flows/erro";
import { logger } from "@/lib/logger";
import { mensagemDeDisparoSchema, type MensagemDeDisparo } from "@/lib/schemas/disparos";

/** Quantos disparos diferentes um tick atende. */
const DISPAROS_POR_TICK = 5;
/**
 * Quantas mensagens saem por disparo, por tick. Com o cron de um minuto, é o
 * throttle: 12/min ≈ 1 a cada 5s, a cadência de campanha da doutrina.
 */
const LOTE_POR_TICK = 12;
/** Lease do claim. Maior que o tempo de um lote, menor que o intervalo do cron. */
const LEASE_SEGUNDOS = 50;

export interface ResumoDoTick {
  disparos: number;
  enviados: number;
  falhas: number;
  concluidos: number;
  claim_falhou: boolean;
}

interface LinhaDeDisparo {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  message: unknown;
  sent_count: number;
  failed_count: number;
  started_at: string | null;
}

interface LinhaDeDestinatario {
  id: string;
  organization_id: string;
  broadcast_id: string;
  contact_id: string;
  service_boundary: unknown;
}

/** O corpo que sai, já com as variáveis do contato resolvidas. */
export function entradaDeDisparo(
  mensagem: MensagemDeDisparo,
  conversationId: string,
  contexto: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (mensagem.window_mode === "outside_24h") {
    if (!mensagem.template_name || !mensagem.template_language) {
      return { ok: false, error: "template_incompleto" };
    }
    const valores = Object.fromEntries(
      Object.entries(mensagem.template_values ?? {}).map(([slot, valor]) => [
        slot,
        renderFlowTemplate(valor, contexto),
      ]),
    );
    return {
      ok: true,
      input: {
        conversation_id: conversationId,
        type: "template",
        template_name: mensagem.template_name,
        template_language: mensagem.template_language,
        template_values: valores,
      },
    };
  }
  const body = renderFlowTemplate(mensagem.body ?? "", contexto);
  if (!body.trim()) return { ok: false, error: "missing_body" };
  return { ok: true, input: { conversation_id: conversationId, type: "text", body } };
}

interface FluxoDoDisparo {
  id: string;
}

/**
 * Modo fluxo: o destinatário ENTRA no fluxo do disparo, carregando a permissão
 * que o agendamento materializou para ele.
 *
 * As guardas são as mesmas do envio direto (contato ainda apto, permissão
 * presente e ainda vigente), mais uma de escopo: a permissão é deste
 * destinatário — organização e contato. O banco repete a conferência na
 * inserção (`fn_flow_execution_do_disparo_coerente`) e amarra a execução ao
 * disparo DONO do fluxo.
 *
 * Desfecho: `sent` = entrou no fluxo e o primeiro trecho rodou sem falha;
 * `failed` = a execução falhou (o motivo real vai para o destinatário);
 * `skipped` = nem entrou.
 */
async function iniciarNoFluxo(
  admin: SupabaseClient,
  destinatario: LinhaDeDestinatario,
  fluxo: FluxoDoDisparo,
): Promise<"sent" | "failed" | "skipped"> {
  const agora = new Date().toISOString();
  const marcar = (status: "sent" | "failed" | "skipped", error: string | null) =>
    admin
      .from("broadcast_recipients")
      .update({ status, error, sent_at: status === "sent" ? agora : null, claimed_until: null, updated_at: agora })
      .eq("id", destinatario.id)
      .eq("organization_id", destinatario.organization_id);

  const { data: contato } = await admin
    .from("contacts")
    .select("id, is_blocked, is_anonymized, is_merged_into")
    .eq("id", destinatario.contact_id)
    .eq("organization_id", destinatario.organization_id)
    .maybeSingle();
  if (!contato || contato.is_blocked || contato.is_anonymized || contato.is_merged_into !== null) {
    await marcar("skipped", !contato ? "contato_nao_encontrado" : "contato_bloqueado_ou_anonimizado");
    return "skipped";
  }

  const boundary = parseServiceBoundary(destinatario.service_boundary);
  if (!boundary) {
    await marcar("skipped", "sem_fronteira_de_servico");
    return "skipped";
  }
  // A permissão é DESTE destinatário. Uma de outra organização ou de outro
  // contato não serve — nem para começar.
  if (boundary.organization_id !== destinatario.organization_id || boundary.contact_id !== destinatario.contact_id) {
    await marcar("skipped", "service_scope_mismatch");
    return "skipped";
  }

  try {
    await assertServiceBoundarySupabase(admin, boundary);
    const r = await startFlowExecution(admin, {
      organizationId: destinatario.organization_id,
      flowId: fluxo.id,
      contactId: destinatario.contact_id,
      autorizacao: { serviceBoundary: boundary, broadcastRecipientId: destinatario.id },
    });
    if (!r.ok) {
      // `already_active`: o índice único por destinatário (ou por contato em
      // voo) barrou uma segunda execução — um lease que venceu no meio do lote.
      // A pessoa JÁ está no fluxo; não é falha, e não recebe de novo.
      if (r.reason === "already_active") {
        await marcar("sent", null);
        return "sent";
      }
      await marcar("failed", r.reason ?? "flow_start_failed");
      return "failed";
    }
    const { data: exec } = await admin
      .from("flow_executions")
      .select("status, last_error")
      .eq("id", r.executionId!)
      .eq("organization_id", destinatario.organization_id)
      .maybeSingle();
    if ((exec as { status?: string } | null)?.status === "failed") {
      await marcar("failed", ((exec as { last_error?: string | null }).last_error ?? "flow_failed").slice(0, 300));
      return "failed";
    }
    await marcar("sent", null);
    return "sent";
  } catch (err) {
    await marcar("failed", motivoDoErro(err).slice(0, 300));
    return "failed";
  }
}

async function enviarUm(
  admin: SupabaseClient,
  disparo: LinhaDeDisparo,
  destinatario: LinhaDeDestinatario,
  mensagem: MensagemDeDisparo,
  requestId: string,
): Promise<"sent" | "failed" | "skipped"> {
  const agora = new Date().toISOString();

  // A GUARDA DE ÚLTIMA HORA. O público foi materializado quando o operador
  // agendou; entre aquele instante e este, o contato pode ter respondido STOP,
  // pedido anonimização ou sido mesclado. Reler é barato e é a diferença entre
  // uma campanha e uma denúncia.
  const { data: contato } = await admin
    .from("contacts")
    .select("id, name, display_name, phone_number, email, tags, custom_fields, is_blocked, is_anonymized, is_merged_into")
    .eq("id", destinatario.contact_id)
    .eq("organization_id", destinatario.organization_id)
    .maybeSingle();

  const bloqueado =
    !contato || contato.is_blocked || contato.is_anonymized || contato.is_merged_into !== null;
  if (bloqueado) {
    await admin
      .from("broadcast_recipients")
      .update({
        status: "skipped",
        error: !contato ? "contato_nao_encontrado" : "contato_bloqueado_ou_anonimizado",
        claimed_until: null,
        updated_at: agora,
      })
      .eq("id", destinatario.id);
    return "skipped";
  }

  const boundary = parseServiceBoundary(destinatario.service_boundary);
  if (!boundary) {
    await admin
      .from("broadcast_recipients")
      .update({ status: "skipped", error: "sem_fronteira_de_servico", claimed_until: null, updated_at: agora })
      .eq("id", destinatario.id);
    return "skipped";
  }

  try {
    // Recusa se a conversa mudou de estado desde a autorização.
    await assertServiceBoundarySupabase(admin, boundary);

    const envio = entradaDeDisparo(mensagem, boundary.conversation_id, { contact: contato });
    if (!envio.ok) throw new Error(envio.error);

    await sendMessageHandler(
      admin,
      {
        organization_id: destinatario.organization_id,
        serviceBoundary: boundary,
        proactiveContext: {
          organizationId: destinatario.organization_id,
          contactId: destinatario.contact_id,
        },
        actor: { type: "webhook_source", id: disparo.id },
        requestId,
      },
      envio.input as Parameters<typeof sendMessageHandler>[2],
    );

    await admin
      .from("broadcast_recipients")
      .update({ status: "sent", sent_at: agora, error: null, claimed_until: null, updated_at: agora })
      .eq("id", destinatario.id);
    return "sent";
  } catch (err) {
    await admin
      .from("broadcast_recipients")
      .update({
        status: "failed",
        error: motivoDoErro(err).slice(0, 300),
        claimed_until: null,
        updated_at: agora,
      })
      .eq("id", destinatario.id);
    return "failed";
  }
}

export async function runBroadcastWorkerTick(admin: SupabaseClient): Promise<ResumoDoTick> {
  const resumo: ResumoDoTick = {
    disparos: 0,
    enviados: 0,
    falhas: 0,
    concluidos: 0,
    claim_falhou: false,
  };

  const { data: disparos, error: claimErr } = await admin.rpc("fn_claim_due_broadcasts", {
    p_limit: DISPAROS_POR_TICK,
    p_lease_seconds: LEASE_SEGUNDOS,
  });
  if (claimErr) {
    logger.error("[broadcast-worker] claim falhou", { error: claimErr.message });
    resumo.claim_falhou = true;
    return resumo;
  }

  for (const bruto of (disparos ?? []) as LinhaDeDisparo[]) {
    resumo.disparos += 1;
    const requestId = `broadcast:${bruto.id}`;

    const parsed = mensagemDeDisparoSchema.safeParse(bruto.message ?? {});
    if (!parsed.success) {
      // Mensagem inválida no banco: o disparo não pode ficar rodando em falso.
      await admin
        .from("broadcasts")
        .update({
          status: "failed",
          last_error: "mensagem_invalida",
          claimed_until: null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", bruto.id);
      continue;
    }

    // O fluxo do disparo, se houver — recortado pela organização DO DISPARO.
    // Um fluxo de outra organização nunca é achado aqui, e a FK composta de
    // `flows.broadcast_id` impede que ele exista.
    const { data: fluxo, error: fluxoErr } = await admin
      .from("flows")
      .select("id")
      .eq("organization_id", bruto.organization_id)
      .eq("broadcast_id", bruto.id)
      .maybeSingle();
    if (fluxoErr) {
      logger.error("[broadcast-worker] leitura do fluxo do disparo falhou", {
        broadcast_id: bruto.id,
        error: fluxoErr.message,
      });
      await admin.from("broadcasts").update({ claimed_until: null }).eq("id", bruto.id);
      continue;
    }

    if (!bruto.started_at) {
      await admin
        .from("broadcasts")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", bruto.id);
    }

    const { data: lote, error: loteErr } = await admin.rpc("fn_claim_due_broadcast_recipients", {
      p_broadcast: bruto.id,
      p_limit: LOTE_POR_TICK,
      p_lease_seconds: LEASE_SEGUNDOS,
    });
    if (loteErr) {
      logger.error("[broadcast-worker] claim de destinatários falhou", {
        broadcast_id: bruto.id,
        error: loteErr.message,
      });
      await admin.from("broadcasts").update({ claimed_until: null }).eq("id", bruto.id);
      continue;
    }

    let enviados = 0;
    let falhas = 0;
    for (const destinatario of (lote ?? []) as LinhaDeDestinatario[]) {
      // O lote veio do claim POR DISPARO; ainda assim, destinatário de outra
      // organização não passa daqui.
      if (destinatario.organization_id !== bruto.organization_id || destinatario.broadcast_id !== bruto.id) {
        falhas += 1;
        continue;
      }
      const desfecho = fluxo
        ? await iniciarNoFluxo(admin, destinatario, fluxo as FluxoDoDisparo)
        : await enviarUm(admin, bruto, destinatario, parsed.data, requestId);
      if (desfecho === "sent") enviados += 1;
      else if (desfecho === "failed") falhas += 1;
    }
    resumo.enviados += enviados;
    resumo.falhas += falhas;

    // Os contadores saem de uma CONTAGEM, não de um incremento acumulado no
    // processo: incrementar `sent_count + enviados` a partir do valor lido no
    // claim perderia o que outro tick gravou no meio. A contagem é a verdade.
    const { count: pendentes } = await admin
      .from("broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", bruto.id)
      .eq("status", "pending");
    const { count: enviadosTotal } = await admin
      .from("broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", bruto.id)
      .eq("status", "sent");
    const { count: falhasTotal } = await admin
      .from("broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", bruto.id)
      .eq("status", "failed");
    const { count: puladosTotal } = await admin
      .from("broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", bruto.id)
      .eq("status", "skipped");

    const acabou = (pendentes ?? 0) === 0;
    if (acabou) resumo.concluidos += 1;

    await admin
      .from("broadcasts")
      .update({
        status: acabou ? "completed" : "running",
        sent_count: enviadosTotal ?? 0,
        failed_count: falhasTotal ?? 0,
        skipped_count: puladosTotal ?? 0,
        finished_at: acabou ? new Date().toISOString() : null,
        // Reagenda para o próximo minuto. O lease some junto: manter o claim
        // depois de devolver o disparo travaria a fila por 50 segundos à toa.
        next_run_at: acabou ? null : new Date(Date.now() + 60_000).toISOString(),
        claimed_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", bruto.id);
  }

  return resumo;
}
