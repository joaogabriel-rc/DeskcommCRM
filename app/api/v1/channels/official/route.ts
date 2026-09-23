import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta, appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import { disponibilidadeDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar";
import { metaGraphBase } from "@/lib/channels/meta/credentials";
import { COLUNAS_DO_DESFECHO_DO_WEBHOOK } from "@/lib/channels/meta/webhook-da-sessao";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  phone_number_id: z.string().min(5),
  waba_id: z.string().min(5),
  token: z.string().min(20),
});

interface DesfechoGravado {
  meta_webhook_override_uri: string | null;
  meta_webhook_override_erro: string | null;
  meta_webhook_override_em: string | null;
}

/**
 * O desfecho do registro do webhook desta sessão, lido em consulta PRÓPRIA.
 *
 * Separado do select principal de propósito: as três colunas chegam na migration
 * 0311, e num banco sem ela o select inteiro voltaria 42703 — a tela perderia o
 * canal (conectado, número, URL) por causa de um EXTRA. Aqui a ausência só significa
 * "estado do registro indisponível".
 */
async function lerDesfechoDoWebhook(
  admin: ReturnType<typeof createAdminClient>,
  channelSessionId: string,
): Promise<DesfechoGravado | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS_DO_DESFECHO_DO_WEBHOOK)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) return null;
  return data as DesfechoGravado | null;
}

/**
 * A validade do token, em consulta própria pelo mesmo motivo de
 * `lerDesfechoDoWebhook`: a coluna chega na migration 0392, e sem ela o select
 * principal perderia o canal inteiro por causa de um dado acessório.
 */
async function lerValidadeDoToken(
  admin: ReturnType<typeof createAdminClient>,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("meta_token_expires_at")
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) return null;
  return (data as { meta_token_expires_at?: string | null } | null)?.meta_token_expires_at ?? null;
}

/**
 * O token de verificação que esta tela pode MOSTRAR — e de onde vem o que vale.
 *
 * Isto lia `process.env.META_WEBHOOK_VERIFY_TOKEN` direto, e a migration 0257
 * tornou a leitura errada nos dois sentidos: com o App da Meta cadastrado pela
 * tela de administração, o handshake passa a conferir o token do BANCO, e esta
 * rota seguia mostrando o do `.env` (que a Meta recusaria) ou, sem `.env`,
 * "defina no servidor" para quem já tinha configurado tudo.
 *
 * O valor do banco NÃO é devolvido: ele é mostrado uma vez, na resposta da
 * action que o gera (`app/actions/settings/updateMetaApp.ts`), e aqui quem
 * responde é o admin de UM tenant, não quem administra a instalação. O do `.env`
 * continua sendo mostrado, como sempre foi — é o mesmo valor, na mesma rota.
 *
 * Por que "o que vale é igual ao do `.env`" basta para rotular a origem como
 * `ambiente`: o token em vigor (`lib/channels/meta/app.ts`) é OU o do banco OU o
 * do `.env` — o do banco só vale com o par inteiro decifrado; fora disso vale o
 * que o `.env` tiver, até pela metade. Então a igualdade só engana num caso: o
 * token do banco coincidir com o do `.env`. E o do banco ninguém escolhe — é
 * gerado pelo servidor com 32 bytes aleatórios —, então coincidir exige alguém
 * ter COPIADO o token gerado para o `.env`. Nesse caso o rótulo erra a origem,
 * mas o valor exibido é o mesmo que já está no `.env`, que esta rota sempre
 * mostrou: não sai nada que antes não saía.
 */
async function tokenDeVerificacaoParaATela(): Promise<{
  verifyToken: string | null;
  verifyTokenOrigem: "ambiente" | "instalacao" | null;
}> {
  const { verifyToken: emVigor } = await appDaMeta();
  if (!emVigor) return { verifyToken: null, verifyTokenOrigem: null };
  if (emVigor === appDaMetaDoAmbiente().verifyToken) {
    return { verifyToken: emVigor, verifyTokenOrigem: "ambiente" };
  }
  return { verifyToken: null, verifyTokenOrigem: "instalacao" };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, webhook_path_token, status")
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );

  const base = basePublicaDaInstalacao(req);
  const desfecho = data?.id ? await lerDesfechoDoWebhook(admin, data.id) : null;
  const tokenExpiraEm = data?.id ? await lerValidadeDoToken(admin, data.id) : null;
  const cadastro = await disponibilidadeDoCadastroIncorporado();
  return ok({
    /**
     * O Cadastro Incorporado da Meta pode ser oferecido nesta instalação? O App ID
     * e o Configuration ID chegam ao navegador pelo `<PublicEnvScript/>`; o que só
     * o servidor sabe — se o App Secret existe — vem daqui, junto da versão da
     * Graph que o SDK precisa usar (a mesma do resto do canal).
     */
    cadastroIncorporado: {
      disponivel: cadastro.disponivel,
      faltando: cadastro.disponivel ? [] : cadastro.faltando,
      versaoDaGraph: cadastro.versaoDaGraph,
      configurarNaInstalacao: authz.user.is_platform_admin && !authz.user.support,
    },
    /** Validade do token gravado. `null` = não expira ou desconhecida (fluxo manual). */
    tokenExpiraEm,
    connected: Boolean(data),
    channel_session_id: data?.id ?? null,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data?.meta_token_encrypted),
    phoneNumberId: data?.meta_phone_number_id ?? null,
    wabaId: data?.meta_waba_id ?? null,
    /** Base pública da Graph API — para o operador reaproveitar em outro sistema. */
    endpoint: data ? metaGraphBase() : null,
    displayName: data?.display_name ?? null,
    phoneNumber: data?.phone_number ?? null,
    status: data?.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: data
      ? {
          callbackUrl: `${base}/api/v1/webhooks/meta/${data.webhook_path_token}`,
          ...(await tokenDeVerificacaoParaATela()),
          // A porta para quem PODE abrir a tela da instalação — mesma regra do
          // link de `/admin/google` na Agenda. Para o admin de um tenant qualquer
          // o link seria um 404; a tela diz a ele quem procurar.
          configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
          fields: ["messages", "message_template_status_update"],
        }
      : null,
    /**
     * E o que a instalação já fez SOZINHA (fatia F1): o webhook deste número está
     * registrado na Meta ou ainda não? `registrado: false` com `erro` é estado
     * esperado e não falha da conexão — o canal ENVIA normalmente; o que depende
     * disto é a ENTREGA. A tela mostra o motivo e oferece tentar de novo.
     */
    webhookRegistro: data
      ? {
          registrado:
            Boolean(desfecho?.meta_webhook_override_uri) && !desfecho?.meta_webhook_override_erro,
          url: desfecho?.meta_webhook_override_uri ?? null,
          erro: desfecho?.meta_webhook_override_erro ?? null,
          em: desfecho?.meta_webhook_override_em ?? null,
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("phone_number_id, waba_id e token são obrigatórios"), 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token } = parsed.data;

  // Validar, cifrar, gravar e registrar o webhook é o MESMO caso de uso do
  // Cadastro Incorporado — mora em `lib/channels/meta/conectar.ts`, e a rota só
  // traduz o desfecho. A validação vem ANTES de qualquer escrita: gravar primeiro
  // e descobrir depois é o que faz o operador achar que conectou.
  const desfecho = await conectarCanalOficial({
    admin: createAdminClient(),
    organizationId: orgId,
    userId,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: waba_id,
    token,
    base: basePublicaDaInstalacao(req),
  });

  if (!desfecho.ok) {
    switch (desfecho.motivo) {
      case "credencial_recusada":
        return fail("invalid_request", desfecho.detalhe, 422, { requestId });
      case "cifra_indisponivel":
        // Sem a GUC de cifra, gravar o token em claro seria pior que recusar.
        return fail(
          "invalid_request",
          t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"),
          422,
          { requestId },
        );
      case "numero_em_outra_organizacao":
        return fail(
          "state_conflict",
          t("Este número já está conectado em outra organização desta instalação."),
          409,
          { requestId },
        );
      case "falha_ao_gravar":
        return fail("internal_error", desfecho.detalhe, 500, { requestId });
    }
  }

  const webhook = desfecho.webhookRegistro;
  return ok({
    connected: true,
    displayName: desfecho.displayName,
    phoneNumber: desfecho.phoneNumber,
    /** `registrado: false` NÃO desfaz a conexão — o canal envia; falta a entrega. */
    webhookRegistro: webhook
      ? { registrado: webhook.registrado, url: webhook.url, erro: webhook.erro, em: webhook.em }
      : null,
  });
}
