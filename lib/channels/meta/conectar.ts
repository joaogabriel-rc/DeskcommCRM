/**
 * Conectar o canal oficial de uma organização — o caso de uso de PERSISTÊNCIA,
 * compartilhado pelos dois caminhos de entrada: o formulário manual (o operador
 * cola número, WABA e token) e o Cadastro Incorporado da Meta (o servidor
 * descobre os três a partir do code). Os dois mudam só COMO o trio chega; o que
 * se faz com ele é um só, e mora aqui para não divergir.
 *
 * A ordem é contrato:
 *
 * 1. VALIDA antes de gravar, com a WABA junto: o par trocado (número de uma
 *    conta, id de outra) enviaria e nunca receberia (issue #850, fatia F1).
 * 2. CIFRA antes de escrever — sem a GUC de cifra, recusar é melhor que gravar o
 *    token em claro.
 * 3. REUSA a linha oficial da organização, inclusive arquivada: conectar por cima
 *    de um canal excluído o ressuscita (`reactivateChannelSession`), e ignorá-la
 *    criaria uma segunda linha oficial na org.
 * 4. REGISTRA o webhook DEPOIS de gravar: o GET de verificação da Meta chega no
 *    instante do registro e procura a sessão pelo `webhook_path_token`.
 *
 * O MODO do número (Cloud API dedicada ou coexistência com o app WhatsApp
 * Business, migration 0417) é perguntado à Meta aqui, nos dois caminhos — é a
 * resposta dela que vale, nunca o evento que o navegador repassou. A pergunta é
 * acessória: sem resposta, a conexão segue e o modo fica como estava.
 */
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { modoPelaResposta, type ModoDoCanalOficial } from "@/lib/channels/meta/modo-do-canal";
import { consultarModoDoNumero, validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import {
  registrarWebhookDaSessao,
  type DesfechoDoWebhookDaSessao,
} from "@/lib/channels/meta/webhook-da-sessao";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface EntradaDaConexao {
  admin: ReturnType<typeof createAdminClient>;
  /** De fonte confiável (sessão autenticada), nunca do corpo. */
  organizationId: string;
  userId: string;
  requestId: string;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  /**
   * Base pública do CALLBACK da Meta — `basePublicaDoWebhookMeta`, que respeita o
   * `META_WEBHOOK_BASE_URL` (#1426). Só compõe a URL do webhook registrado na Meta.
   */
  base: string;
  /**
   * Validade do token. `undefined` = não mexe na coluna (o fluxo manual não sabe);
   * `null` = não expira; ISO = expira nessa data.
   */
  tokenExpiraEm?: string | null;
  /**
   * `true` quando a conexão veio do Cadastro Incorporado: grava
   * `meta_onboarding_em`. O formulário manual não é onboarding e não o passa.
   */
  onboarding?: boolean;
}

export type DesfechoDaConexao =
  | {
      ok: true;
      channelSessionId: string | null;
      displayName: string;
      phoneNumber: string | null;
      webhookRegistro: DesfechoDoWebhookDaSessao | null;
      /** O que a Meta respondeu sobre o número; `null` = sem resposta. */
      modo: ModoDoCanalOficial | null;
    }
  | { ok: false; motivo: "credencial_recusada"; detalhe: string }
  | { ok: false; motivo: "cifra_indisponivel" }
  | { ok: false; motivo: "numero_em_outra_organizacao" }
  | { ok: false; motivo: "falha_ao_gravar"; detalhe: string };

export async function conectarCanalOficial(entrada: EntradaDaConexao): Promise<DesfechoDaConexao> {
  const { admin, organizationId, userId, requestId, phoneNumberId, wabaId, token } = entrada;

  const validacao = await validateMetaCredentials({ phoneNumberId, token, wabaId });
  if (!validacao.ok) return { ok: false, motivo: "credencial_recusada", detalhe: validacao.motivo };

  const modo = await perguntarModo(phoneNumberId, token, requestId);

  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) return { ok: false, motivo: "cifra_indisponivel" };

  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}, webhook_path_token`),
    () => buscarExistente("id, webhook_path_token"),
  );
  const existente = existenteRaw as {
    id: string;
    archived_at?: string | null;
    webhook_path_token?: string | null;
  } | null;

  const linha = {
    organization_id: organizationId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  // `update` e não upsert: a trava única de (org, phone_number) é um índice
  // PARCIAL (`where archived_at is null`, migration 0107), que o `ON CONFLICT`
  // só infere repetindo o predicado — e o cliente do PostgREST não expõe isso.
  let idDaSessao: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let error: { code?: string | null; message?: string | null } | null = null;

  if (existente) {
    ({ error } = await reactivateChannelSession(
      admin,
      {
        organizationId,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at ?? null,
      },
      linha,
      {
        userId,
        requestId,
        metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
      },
    ));
  } else {
    const inserida = await admin
      .from("channel_sessions")
      .insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      })
      .select("id, webhook_path_token")
      .maybeSingle();
    error = inserida.error;
    idDaSessao = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (error) {
    // `23505`: o índice 0165 recusa o mesmo número ativo em duas organizações.
    if (error.code === "23505") return { ok: false, motivo: "numero_em_outra_organizacao" };
    return { ok: false, motivo: "falha_ao_gravar", detalhe: error.message ?? "channel_session_write_failed" };
  }

  const webhookRegistro =
    idDaSessao && webhookPathToken
      ? await registrarWebhookDaSessao({
          admin,
          channelSessionId: idDaSessao,
          phoneNumberId,
          wabaId,
          tokenCifrado: cifrado,
          webhookPathToken,
          base: entrada.base,
          requestId,
        })
      : null;

  if (idDaSessao && entrada.tokenExpiraEm !== undefined) {
    await gravarValidadeDoToken(admin, organizationId, idDaSessao, entrada.tokenExpiraEm, requestId);
  }

  if (idDaSessao) {
    await gravarModoDoCanal(admin, organizationId, idDaSessao, modo, entrada.onboarding === true, requestId);
  }

  return {
    ok: true,
    channelSessionId: idDaSessao,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    webhookRegistro,
    modo,
  };
}

/**
 * Pergunta à Meta se o número continua no app WhatsApp Business. Nunca lança:
 * o modo é informação sobre o canal, não condição para ele existir.
 */
async function perguntarModo(
  phoneNumberId: string,
  token: string,
  requestId: string,
): Promise<ModoDoCanalOficial | null> {
  try {
    const consulta = await consultarModoDoNumero({ phoneNumberId, token });
    if (consulta.ok) return modoPelaResposta(consulta.isOnBizApp);
    logger.warn("[meta.conectar] a Meta não respondeu o modo do número — fica sem modo", {
      requestId,
      motivo: consulta.motivo.slice(0, 200),
    });
  } catch (err) {
    logger.warn("[meta.conectar] consulta do modo do número lançou — fica sem modo", {
      requestId,
      erro: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
  }
  return null;
}

/**
 * Update PRÓPRIO, pela mesma razão de `gravarValidadeDoToken`: num banco sem a
 * migration 0417 as colunas não existem, e levá-las junto recusaria a escrita
 * inteira. Modo sem resposta NÃO é gravado: numa reconexão, apagaria o modo que
 * a Meta confirmou antes.
 */
async function gravarModoDoCanal(
  admin: EntradaDaConexao["admin"],
  organizationId: string,
  channelSessionId: string,
  modo: ModoDoCanalOficial | null,
  onboarding: boolean,
  requestId: string,
): Promise<void> {
  const patch: { meta_modo?: ModoDoCanalOficial; meta_onboarding_em?: string } = {};
  if (modo !== null) patch.meta_modo = modo;
  if (onboarding) patch.meta_onboarding_em = new Date().toISOString();
  if (Object.keys(patch).length === 0) return;

  const { error } = await admin
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId);
  if (!error) return;
  logger.warn("[meta.conectar] modo do canal não gravado", {
    requestId,
    channelSessionId,
    schemaDesatualizado: /meta_modo|meta_onboarding_em/.test(error.message ?? ""),
  });
}

/**
 * Update PRÓPRIO, e não uma chave a mais em `linha`: num banco sem a migration
 * 0398 a coluna não existe, e levá-la junto faria o PostgREST recusar a escrita
 * inteira (42703) — o canal deixaria de conectar por causa de um dado acessório.
 */
async function gravarValidadeDoToken(
  admin: EntradaDaConexao["admin"],
  organizationId: string,
  channelSessionId: string,
  expiraEm: string | null,
  requestId: string,
): Promise<void> {
  const { error } = await admin
    .from("channel_sessions")
    .update({ meta_token_expires_at: expiraEm })
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId);
  if (!error) return;
  logger.warn("[meta.conectar] validade do token não gravada", {
    requestId,
    channelSessionId,
    schemaDesatualizado: (error.message ?? "").includes("meta_token_expires_at"),
  });
}
