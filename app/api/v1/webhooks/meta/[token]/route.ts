/**
 * GET|POST /api/v1/webhooks/meta/[token] — webhook da WhatsApp Cloud API, rota de
 * COMPATIBILIDADE. O endpoint principal é o universal, `/api/v1/webhooks/meta`, que
 * descobre a organização pelo número no payload assinado. Esta continua viva porque
 * o override por número (`webhook-da-sessao.ts`) ainda aponta para ela, e os dois
 * processam pelo mesmo código (`lib/channels/meta/processar-evento.ts`).
 *
 * `GET` é o handshake de verificação: a Meta só começa a entregar eventos depois
 * que o endpoint devolve `hub.challenge` **em texto puro**. Envelopar em
 * `{data:...}` (o wrapper padrão da nossa API) faz a verificação falhar com uma
 * mensagem inútil no dashboard — por isso esta é a única rota do repo que
 * responde texto cru, e está aqui escrito o motivo.
 *
 * `POST` verifica HMAC **SHA-256** com o App Secret, e só então age. O outro canal
 * do repo usa SHA-512 com segredo por sessão — não reaproveite a verificação dele;
 * o detalhe está em `lib/channels/meta/webhook.ts`.
 *
 * Por que ainda existe token no path se o App Secret é global: o segredo é do APP,
 * e um app serve N WABAs de N organizações. O token amarra o payload a UMA org
 * antes de qualquer escrita — sem ele, quem conhecesse o App Secret escreveria em
 * qualquer tenant.
 *
 * ─── De onde vêm as duas credenciais (issue #850, migration 0257) ─────────────
 *
 * Do BANCO (`platform_meta_app`), não do ambiente: as duas são da INSTALAÇÃO
 * inteira, não da organização — é isto que faz o 2º número conectar sem ninguém
 * voltar na VPS para editar `.env` e reiniciar. O `.env` continua sendo o PISO
 * (rollback, e clone que ainda não aplicou a migration) e as duas fontes NÃO se
 * misturam: segredo de um lado com verify token do outro é um app que não existe,
 * e a falha é um 401 calado que ninguém liga a configuração. A precedência, o TTL
 * e esse motivo estão escritos em `lib/channels/meta/app.ts`.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { lerEntregaDaMeta, processarEventoDaMeta } from "@/lib/channels/meta/processar-evento";
import { metaSessionByWebhookToken } from "@/lib/channels/meta/session";
import { verificationChallenge } from "@/lib/channels/meta/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const session = await metaSessionByWebhookToken(token);
  if (!session) return new NextResponse("not found", { status: 404 });

  // Do BANCO (platform_meta_app, migration 0257), com o `.env` como piso: é a
  // credencial da INSTALAÇÃO inteira, não da organização — e um clone que ainda
  // não aplicou a migration continua verificado pelo ambiente. Não lança nunca;
  // a precedência e o porquê estão em `lib/channels/meta/app.ts`.
  const { verifyToken } = await appDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });

  // Texto puro, sem wrapper — ver o cabeçalho.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const session = await metaSessionByWebhookToken(token);
  if (!session) return fail("not_found", "unknown webhook token", 404, { requestId });

  // Assinatura, contrato do corpo e parse: os mesmos da rota universal
  // (`lib/channels/meta/processar-evento.ts`).
  const leitura = await lerEntregaDaMeta(await req.text(), req.headers.get("x-hub-signature-256"), requestId);
  if (!leitura.ok) {
    return fail(leitura.codigo, leitura.mensagem, leitura.status, {
      requestId,
      ...(leitura.detalhes !== undefined ? { details: leitura.detalhes } : {}),
    });
  }

  const eventos = leitura.eventos;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  /**
   * Desfecho de cada ingestão de mensagem recebida. Existe porque a versão
   * anterior DESCARTAVA o retorno: um insert que falhava virava `{"received": 1}`
   * com nada gravado, e "chegou e falhou" ficava indistinguível de "não chegou".
   */
  const desfechos: string[] = [];

  for (const e of eventos) {
    // A organização vem do TOKEN DO PATH, nunca do corpo (issue #236).
    const desfecho = await processarEventoDaMeta(admin, e, session, now);
    if (e.kind === "inbound_message" && desfecho && desfecho !== "waba_divergente") {
      desfechos.push(desfecho);
    }
  }

  // 200 SEMPRE que a assinatura confere, inclusive para evento que não nos
  // interessa: a Meta re-entrega tudo que não recebe 2xx, e recusar o que
  // ignoramos vira re-tentativa em backoff por horas.
  // `outcomes` no corpo: quem depura vê o que aconteceu com cada evento em vez de
  // ler um contador que não distingue sucesso de falha.
  return NextResponse.json(
    { received: eventos.length, outcomes: desfechos },
    { status: 200 },
  );
}
