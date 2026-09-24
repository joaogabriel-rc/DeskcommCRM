/**
 * POST /api/v1/channels/official/cadastro/concluir — o navegador entrega o
 * authorization code do Cadastro Incorporado da Meta, e o servidor faz o resto.
 *
 * O corpo traz o `state` emitido por `/iniciar`, o `code` (30 s de validade, uso
 * único) e, como SUGESTÃO, o evento e os ids que a mensagem `WA_EMBEDDED_SIGNUP`
 * trouxe. A sugestão passa pelo navegador — só vale se a Meta a confirmar
 * (`lib/channels/meta/cadastro-incorporado.ts`).
 *
 * ─── A ORDEM É CONTRATO ─────────────────────────────────────────────────────
 * 1. Guardas (suporte, papel, origem) antes de ler o corpo.
 * 2. `state` ANTES de tudo que custa: prova que o fluxo foi aberto por ESTA pessoa
 *    NESTA organização, há menos de 15 minutos. Trocar de organização noutra aba
 *    no meio do fluxo cai aqui.
 * 3. Evento não suportado recusa ANTES da troca: gastar o code de uso único para
 *    depois dizer "não suportado" obrigaria a refazer o fluxo por nada.
 * 4. Queima do nonce ANTES da troca (mesmo raciocínio do callback do Google):
 *    queimar depois gastaria o code antes de descobrir o replay.
 * 5. Troca, inspeção e descoberta, e só então a persistência — a MESMA do
 *    formulário manual (`lib/channels/meta/conectar.ts`).
 *
 * O token nunca volta ao navegador nem vai para log: a resposta traz só o que a
 * tela mostra (nome, número, estado do webhook, validade).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import {
  EVENTOS_NAO_SUPORTADOS,
  appDoCadastro,
  descobrirCanal,
  inspecionarToken,
  trocarCodigoPorToken,
  type ErroDaMeta,
} from "@/lib/channels/meta/cadastro-incorporado";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar";
import {
  PREFIXO_DO_NONCE_DO_CADASTRO,
  verificarEstadoDoCadastro,
} from "@/lib/channels/meta/estado-do-cadastro";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDaInstalacao, basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID_DA_META = /^\d{5,25}$/;

const corpoSchema = z.object({
  state: z.string().min(1).max(2048),
  code: z.string().max(4096).optional(),
  evento: z
    .string()
    .regex(/^[A-Z_]{3,60}$/)
    .optional(),
  sugestao: z
    .object({
      waba_id: z.string().regex(ID_DA_META).optional(),
      phone_number_id: z.string().regex(ID_DA_META).optional(),
    })
    .optional(),
});

/** Cada recusa: o status HTTP, o código canônico e a frase acionável para quem usa. */
const RECUSAS = {
  origem_invalida: [403, "forbidden", "Pedido recusado: ele não veio da tela do CRM."],
  corpo_invalido: [422, "invalid_request", "Pedido incompleto. Tente conectar de novo."],
  code_ausente: [422, "invalid_request", "A Meta não devolveu a autorização. Tente conectar de novo."],
  estado_invalido: [403, "forbidden", "Esta conexão expirou ou foi aberta por outra pessoa ou organização. Comece de novo."],
  estado_reutilizado: [409, "state_conflict", "Esta autorização já foi usada. Comece a conexão de novo."],
  nonce_indisponivel: [503, "unavailable", "Não foi possível conferir a conexão agora. Tente de novo em instantes."],
  evento_nao_suportado: [422, "invalid_request", "Este tipo de conexão ainda não é suportado. Use um número dedicado à API oficial, sem o aplicativo WhatsApp Business."],
  cadastro_indisponivel: [409, "state_conflict", "A conexão pela Meta não está configurada nesta instalação."],
  code_expirado: [422, "invalid_request", "A autorização da Meta expirou antes de chegar ao CRM. Tente conectar de novo."],
  code_usado: [409, "state_conflict", "Esta autorização da Meta já foi usada. Tente conectar de novo."],
  code_invalido: [422, "invalid_request", "A Meta não aceitou a autorização. Tente conectar de novo."],
  app_recusado: [409, "state_conflict", "A Meta recusou o aplicativo configurado nesta instalação. Quem administra a instalação precisa conferir o App ID e o App Secret."],
  meta_indisponivel: [502, "upstream_unavailable", "A Meta não respondeu agora. Tente de novo em alguns minutos."],
  token_invalido: [422, "invalid_request", "A Meta devolveu uma autorização que não vale. Tente conectar de novo."],
  token_de_outro_app: [409, "state_conflict", "A autorização pertence a outro aplicativo da Meta. Quem administra a instalação precisa conferir o App ID."],
  waba_nao_encontrada: [422, "invalid_request", "Nenhuma conta do WhatsApp Business foi compartilhada na autorização. Refaça a conexão e selecione a conta."],
  waba_ambigua: [422, "invalid_request", "Mais de uma conta do WhatsApp Business foi autorizada. Refaça a conexão escolhendo só uma."],
  waba_nao_autorizada: [403, "forbidden", "A conta do WhatsApp Business indicada não foi autorizada para este CRM. Refaça a conexão."],
  numero_nao_encontrado: [422, "invalid_request", "A conta do WhatsApp Business não tem número. Adicione um número no WhatsApp Manager e conecte de novo."],
  numero_ambiguo: [422, "invalid_request", "A conta tem mais de um número. Refaça a conexão escolhendo o número."],
  numero_nao_pertence: [403, "forbidden", "O número indicado não pertence à conta autorizada. Refaça a conexão."],
  credencial_recusada: [422, "invalid_request", "A Meta não confirmou o número com esta autorização. Tente conectar de novo."],
  cifra_indisponivel: [422, "invalid_request", "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"],
  numero_em_outra_organizacao: [409, "state_conflict", "Este número já está conectado em outra organização desta instalação."],
  falha_ao_gravar: [500, "internal_error", "Não foi possível gravar a conexão. Tente de novo."],
} as const satisfies Record<string, readonly [number, string, string]>;

type Recusa = keyof typeof RECUSAS;

function origemDe(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const organizationId = authz.org.orgId;
  const userId = authz.user.id;

  /** O que as recusas logam além do motivo — preenchido à medida que o corpo é lido. */
  const contexto: { evento?: string } = {};
  const recusar = (motivo: Recusa, erroDaMeta?: ErroDaMeta, detalhe?: Record<string, unknown>) => {
    const [status, codigo, mensagem] = RECUSAS[motivo];
    logger.warn("[meta.cadastro] conexão recusada", {
      requestId,
      organizationId,
      userId,
      motivo,
      evento: contexto.evento,
      ...(erroDaMeta ? { meta: erroDaMeta } : {}),
      ...(detalhe ?? {}),
    });
    return fail(codigo, t(mensagem), status, { requestId, details: { motivo } });
  };

  // Nenhuma recusa DEPOIS da queima do nonce pode ser 429/503: o `apiClient`
  // reenvia esses dois, e o reenvio encontraria o nonce gasto e diria "autorização
  // já usada" no lugar do erro real. Por isso "a Meta não respondeu" é 502.
  //
  // Defesa em profundidade: o cookie de sessão já é SameSite=Strict.
  const origem = origemDe(req.headers.get("origin"));
  if (!origem || origem !== origemDe(basePublicaDaInstalacao(req))) return recusar("origem_invalida");

  const limite = await checkRateLimit(`meta-cadastro:concluir:${organizationId}`, 5, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas tentativas seguidas. Aguarde alguns minutos."), 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return recusar("corpo_invalido");
  const { state, code, sugestao } = parsed.data;
  const evento = parsed.data.evento;
  contexto.evento = evento;

  let estado: ReturnType<typeof verificarEstadoDoCadastro>;
  try {
    estado = verificarEstadoDoCadastro(state, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    return recusar("nonce_indisponivel");
  }
  if (!estado || estado.organizationId !== organizationId || estado.userId !== userId) {
    return recusar("estado_invalido");
  }

  if (!code) return recusar("code_ausente");
  if (evento && EVENTOS_NAO_SUPORTADOS.has(evento)) return recusar("evento_nao_suportado");

  const app = await appDoCadastro();
  if (!app) return recusar("cadastro_indisponivel");

  const admin = createAdminClient();
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: `${PREFIXO_DO_NONCE_DO_CADASTRO}${estado.nonce}`,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    // Sem conseguir gravar não há uso único — seguir abriria a porta justo quando
    // a guarda está fora do ar.
    return recusar(erroDoNonce.code === "23505" ? "estado_reutilizado" : "nonce_indisponivel");
  }

  const troca = await trocarCodigoPorToken(code, app);
  if (!troca.ok) return recusar(troca.motivo, troca.erro);

  const inspecao = await inspecionarToken(troca.token, app);
  if (!inspecao.ok) return recusar(inspecao.motivo, inspecao.erro);

  const canal = await descobrirCanal(troca.token, inspecao.wabasAutorizadas, {
    wabaId: sugestao?.waba_id,
    phoneNumberId: sugestao?.phone_number_id,
  });
  if (!canal.ok) {
    return recusar(canal.motivo, canal.erro, { wabas_autorizadas: inspecao.wabasAutorizadas.length });
  }

  const conexao = await conectarCanalOficial({
    admin,
    organizationId,
    userId,
    requestId,
    phoneNumberId: canal.phoneNumberId,
    wabaId: canal.wabaId,
    token: troca.token,
    // A URL de CALLBACK da Meta (`META_WEBHOOK_BASE_URL`, #1426). A checagem de
    // origem acima segue com a base da INSTALAÇÃO: ela compara com o painel.
    base: basePublicaDoWebhookMeta(req),
    tokenExpiraEm: inspecao.expiraEm,
  });
  if (!conexao.ok) return recusar(conexao.motivo);

  void audit({
    action: "channel.connected",
    actorUserId: userId,
    organizationId,
    resourceType: "channel_session",
    resourceId: conexao.channelSessionId,
    requestId,
    metadata: {
      provider: CHANNEL_PROVIDER_META,
      via: "cadastro_incorporado",
      evento: evento ?? null,
      waba_id: canal.wabaId,
      phone_number_id: canal.phoneNumberId,
      token_expira_em: inspecao.expiraEm,
    },
  });
  logger.info("[meta.cadastro] canal oficial conectado", {
    requestId,
    organizationId,
    userId,
    evento,
    webhookRegistrado: conexao.webhookRegistro?.registrado ?? null,
    tokenExpira: inspecao.expiraEm !== null,
  });

  const webhook = conexao.webhookRegistro;
  return ok({
    connected: true,
    displayName: conexao.displayName,
    phoneNumber: conexao.phoneNumber,
    tokenExpiraEm: inspecao.expiraEm,
    webhookRegistro: webhook
      ? { registrado: webhook.registrado, url: webhook.url, erro: webhook.erro, em: webhook.em }
      : null,
  });
}
