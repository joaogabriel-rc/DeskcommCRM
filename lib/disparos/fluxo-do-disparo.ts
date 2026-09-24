/**
 * O FLUXO PRÓPRIO de um disparo "modo fluxo" (migration 0394).
 *
 * Um disparo tem no máximo um fluxo, e esse fluxo é dele: `flows.broadcast_id`
 * aponta o dono (FK composta com a organização), o gatilho é `broadcast` e o
 * banco amarra os dois (`flows_disparo_coerente`). O fluxo é editado no MESMO
 * construtor das automações (`/app/flows/[id]`), roda no MESMO motor
 * (`lib/flows/engine.ts`) e não aparece na lista de Automações.
 *
 * Este módulo é a única porta que CRIA esse fluxo e a única que diz o que falta
 * nele para o disparo ser agendado — a regra é a mesma de ativar um fluxo
 * (`problemasParaAtivar` + `problemasDosModelos`), mais a do número: todo passo
 * de mensagem que fixa um número tem de usar O MESMO, porque a permissão de
 * envio de cada contato é aberta na conversa de um número só.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverModelo } from "@/lib/channels/catalogo-de-modelos";
import {
  problemasDosModelos,
  problemasParaAtivar,
  type ModeloResolvido,
  type NoParaValidar,
} from "@/lib/flows/validacao";
import type { MessageNodeConfig } from "@/lib/flows/types";

export const GATILHO_DO_DISPARO = "broadcast" as const;

export interface FluxoDoDisparo {
  id: string;
  status: string;
}

/** O fluxo do disparo, recortado pela organização. `null` = disparo guiado. */
export async function fluxoDoDisparo(
  db: SupabaseClient,
  organizationId: string,
  broadcastId: string,
): Promise<FluxoDoDisparo | null> {
  const { data, error } = await db
    .from("flows")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("broadcast_id", broadcastId)
    .maybeSingle();
  if (error) throw new Error(`fluxo_do_disparo: ${error.message}`);
  return (data as FluxoDoDisparo | null) ?? null;
}

/**
 * Cria o fluxo do disparo, com o nó "Quando…" já no gatilho `broadcast`.
 * Idempotente: se o disparo já tem fluxo, devolve o que existe (o índice único
 * `uq_flows_broadcast` barraria o segundo de qualquer jeito).
 */
export async function criarFluxoDoDisparo(
  db: SupabaseClient,
  params: { organizationId: string; broadcastId: string; nomeDoDisparo: string; userId: string },
): Promise<FluxoDoDisparo> {
  const existente = await fluxoDoDisparo(db, params.organizationId, params.broadcastId);
  if (existente) return existente;

  const { data, error } = await db
    .from("flows")
    .insert({
      organization_id: params.organizationId,
      broadcast_id: params.broadcastId,
      created_by_user_id: params.userId,
      name: `Disparo: ${params.nomeDoDisparo}`.slice(0, 120),
      trigger_type: GATILHO_DO_DISPARO,
      trigger_config: {},
    })
    .select("id, status")
    .single();
  if (error || !data) {
    // Corrida com outro clique: o índice único segurou; o fluxo existe.
    if (error?.code === "23505") {
      const agora = await fluxoDoDisparo(db, params.organizationId, params.broadcastId);
      if (agora) return agora;
    }
    throw new Error(`fluxo_do_disparo: ${error?.message ?? "insert_failed"}`);
  }
  const fluxo = data as FluxoDoDisparo;

  const { error: noErr } = await db.from("flow_nodes").insert({
    id: randomUUID(),
    organization_id: params.organizationId,
    flow_id: fluxo.id,
    type: "TRIGGER",
    label: "Quando…",
    config: { trigger_type: GATILHO_DO_DISPARO, config: {} },
    position_x: 80,
    position_y: 80,
  });
  if (noErr) throw new Error(`fluxo_do_disparo: ${noErr.message}`);
  return fluxo;
}

export interface ProntidaoDoFluxo {
  problemas: string[];
  /** O número de envio de todos os passos de mensagem (ou `null` = o padrão do contato). */
  sessao: string | null;
}

/**
 * O que falta no fluxo para o disparo ser agendado, e por qual número a
 * permissão de cada contato tem de ser aberta.
 */
export async function prontidaoDoFluxo(
  db: SupabaseClient,
  organizationId: string,
  fluxo: FluxoDoDisparo,
): Promise<ProntidaoDoFluxo> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("id, type, label, config")
    .eq("organization_id", organizationId)
    .eq("flow_id", fluxo.id);
  if (error) throw new Error(`prontidao_do_fluxo: ${error.message}`);
  const nos = (data ?? []) as NoParaValidar[];

  const problemas = problemasParaAtivar(GATILHO_DO_DISPARO, {}, nos);

  const mensagens = nos.filter((n) => n.type === "MESSAGE").map((n) => n.config as MessageNodeConfig);
  const sessoes = [...new Set(mensagens.map((c) => c.channel_session_id).filter((s): s is string => !!s))];
  if (sessoes.length > 1) {
    problemas.push(
      "Os passos de mensagem deste fluxo usam números diferentes. Num disparo, todos os modelos precisam ser do mesmo número.",
    );
  }

  const mapa = new Map<string, ModeloResolvido | null>();
  for (const no of nos) {
    if (no.type !== "MESSAGE") continue;
    const cfg = no.config as MessageNodeConfig;
    if (cfg.window_mode !== "outside_24h" || !cfg.template_name || !cfg.template_language) continue;
    try {
      mapa.set(
        no.id,
        await resolverModelo(db, organizationId, {
          templateId: cfg.template_id ?? null,
          name: cfg.template_name,
          language: cfg.template_language,
          channelSessionId: cfg.channel_session_id ?? null,
        }),
      );
    } catch {
      // Leitura que falhou não é veredito sobre o modelo (ver problemasDosModelos).
    }
  }
  problemas.push(...problemasDosModelos(nos, mapa));

  return { problemas, sessao: sessoes[0] ?? null };
}

/**
 * O que falta na MENSAGEM do disparo guiado, pelo catálogo central — a mesma
 * régua do nó de mensagem (`problemasDosModelos`), aplicada a um passo só.
 */
export async function problemasDaMensagemGuiada(
  db: SupabaseClient,
  organizationId: string,
  mensagem: MessageNodeConfig,
): Promise<string[]> {
  if (mensagem.window_mode !== "outside_24h" || !mensagem.template_name || !mensagem.template_language) return [];
  const no: NoParaValidar = { id: "mensagem-do-disparo", type: "MESSAGE", label: "a mensagem do disparo", config: mensagem as Record<string, unknown> };
  const mapa = new Map<string, ModeloResolvido | null>();
  try {
    mapa.set(
      no.id,
      await resolverModelo(db, organizationId, {
        templateId: mensagem.template_id ?? null,
        name: mensagem.template_name,
        language: mensagem.template_language,
        channelSessionId: mensagem.channel_session_id ?? null,
      }),
    );
  } catch {
    return [];
  }
  return problemasDosModelos([no], mapa);
}
