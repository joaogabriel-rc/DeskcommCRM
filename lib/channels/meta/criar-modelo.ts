/**
 * CRIAR UM MODELO OFICIAL PELO CRM: conexão → Meta → espelho.
 *
 * A Meta é a autoridade: o modelo nasce LÁ, e o que se grava aqui é o espelho do
 * que ela respondeu — status dela (PENDING na criação), nunca APPROVED presumido.
 * O espelho é o MESMO `meta_templates` que o sync oficial grava, com a MESMA
 * forma (por conta: `waba_id` da conexão, `channel_session_id` nulo) e a MESMA
 * chave do upsert. Por isso o modelo criado aparece no catálogo central
 * (`catalogo-de-modelos.ts`) para Conexões, Fluxos e Disparos, e a próxima
 * sincronização atualiza a linha no lugar em vez de duplicá-la.
 *
 * ─── Ordem, e por que ─────────────────────────────────────────────────────
 *
 *   1. valida o rascunho (recusa local, sem rede e sem banco);
 *   2. a conexão: desta organização, ativa, do canal oficial, com conta;
 *   3. a Meta cria (o adapter resolve conta e credencial pelo PAR organização +
 *      número — `meta/templates.ts`);
 *   4. só com o id devolvido, o espelho é gravado.
 *
 * Recusa da Meta, falha de rede ou credencial: nada é gravado. Se a Meta criou e
 * o espelho falhou, o erro diz as duas coisas — o modelo existe lá, e a
 * sincronização o traz; um registro local "como se" não é inventado.
 *
 * A organização vem de quem chama (sessão autenticada), nunca do corpo; a
 * conexão é conferida CONTRA ela no banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverModelo, type ModeloDoCatalogo } from "../catalogo-de-modelos";
import { CHANNEL_PROVIDER_META } from "../capabilities";
import { getAdapter } from "../index";
import type { ChannelTemplateDraft } from "../types";

import { hashContract } from "./contract-hash";
import { validarRascunhoOficial } from "./templates";

export interface PedidoDeCriacao {
  /** Da sessão autenticada. */
  organizationId: string;
  /** A conexão escolhida na tela — conferida contra a organização. */
  channelSessionId: string;
  draft: ChannelTemplateDraft;
}

export interface ModeloCriado {
  modelo: ModeloDoCatalogo;
  providerTemplateId: string;
}

const ID_NUMERICO = /^\d+$/;

export async function criarModeloOficial(admin: SupabaseClient, pedido: PedidoDeCriacao): Promise<ModeloCriado> {
  const motivo = validarRascunhoOficial(pedido.draft);
  if (motivo) throw new Error(`meta_template_validacao: ${motivo}`);

  // `organization_id` À MÃO: o client é de service role.
  const { data: conexao, error } = await admin
    .from("channel_sessions")
    .select("id, provider, meta_waba_id, meta_phone_number_id")
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`meta_template_conexao: leitura da conexão falhou — ${error.message}`);
  const c = conexao as {
    id: string;
    provider: string;
    meta_waba_id: string | null;
    meta_phone_number_id: string | null;
  } | null;
  if (!c || c.provider !== CHANNEL_PROVIDER_META) {
    throw new Error("meta_template_conexao: escolha uma conexão oficial desta organização.");
  }
  if (!c.meta_waba_id || !ID_NUMERICO.test(c.meta_waba_id)) {
    throw new Error("meta_template_sem_waba: a conexão escolhida não tem conta do WhatsApp Business (WABA) gravada.");
  }
  if (!c.meta_phone_number_id) {
    throw new Error("meta_template_conexao: a conexão não tem número (phone_number_id) gravado.");
  }

  const ops = getAdapter(c.provider).templates;
  if (!ops) throw new Error("meta_template_indisponivel: este canal não cria modelos.");
  const criado = await ops.create({
    organizationId: pedido.organizationId,
    sessionRef: c.meta_phone_number_id,
    draft: pedido.draft,
  });
  const providerTemplateId = criado.providerTemplateId ?? "";
  if (!providerTemplateId) {
    throw new Error("meta_template_rejeitado: a Meta não devolveu o id do modelo criado.");
  }

  const agora = new Date().toISOString();
  const parameterFormat = criado.parameterFormat === "NAMED" ? "NAMED" : "POSITIONAL";
  const { data: linha, error: erroDoEspelho } = await admin
    .from("meta_templates")
    .upsert(
      {
        organization_id: pedido.organizationId,
        // A conta da conexão, como o sync oficial grava — e sem conexão, pelo
        // mesmo motivo: a definição é da CONTA, não do número.
        waba_id: c.meta_waba_id,
        name: criado.name,
        language: criado.language,
        status: criado.status,
        category: criado.category,
        rejected_reason: criado.rejectedReason ?? null,
        components: criado.components,
        contract_hash: hashContract(criado.components, parameterFormat),
        parameter_format: parameterFormat,
        provider_template_id: providerTemplateId,
        synced_at: agora,
        updated_at: agora,
      },
      { onConflict: "organization_id,waba_id,name,language" },
    )
    .select("id")
    .single();
  if (erroDoEspelho || !linha) {
    throw new Error(
      `meta_template_espelho: o modelo foi criado na Meta (id ${providerTemplateId}), mas o espelho local não foi gravado — ` +
        `use Sincronizar com a Meta para trazê-lo. ${erroDoEspelho?.message ?? ""}`.trim(),
    );
  }

  // Devolve pelo CATÁLOGO central — a mesma leitura que Fluxos e Disparos usam,
  // com a mesma régua de "utilizável".
  const modelo = await resolverModelo(admin, pedido.organizationId, { templateId: (linha as { id: string }).id });
  if (!modelo) throw new Error("meta_template_espelho: o espelho foi gravado mas não pôde ser relido.");
  return { modelo, providerTemplateId };
}

/** Prefixo do erro → status HTTP e código da API. Um lugar só, para a rota. */
export function respostaDoErroDeCriacao(mensagem: string): { status: number; code: string } {
  const prefixo = /^([a-z_]+):/.exec(mensagem)?.[1] ?? "";
  switch (prefixo) {
    case "meta_template_validacao":
      return { status: 422, code: "validation_failed" };
    case "meta_template_conexao":
      return { status: 404, code: "not_found" };
    case "meta_template_sem_waba":
    case "meta_not_configured":
      return { status: 409, code: "failed_precondition" };
    case "meta_template_credencial":
    case "meta_template_waba":
    case "meta_template_rejeitado":
      return { status: 502, code: "upstream_error" };
    case "meta_template_rede":
      return { status: 504, code: "upstream_unavailable" };
    case "meta_template_indisponivel":
      return { status: 501, code: "not_implemented" };
    default:
      return { status: 500, code: "internal_error" };
  }
}
