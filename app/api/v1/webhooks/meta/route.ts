/**
 * GET|POST /api/v1/webhooks/meta — o webhook UNIVERSAL da WhatsApp Cloud API.
 *
 * Um endereço só para a instalação inteira: é o callback que se cadastra no app da
 * Meta (`https://<domínio>/api/v1/webhooks/meta`). Um app da Meta atende N WABAs de
 * N organizações, e esta rota descobre a organização de CADA evento pelo número que
 * o recebeu — `value.metadata.phone_number_id` — procurando a sessão oficial ativa
 * dona dele. O evento que não traz número (estado de template) vai pela WABA.
 *
 * A rota por token (`/api/v1/webhooks/meta/[token]`) continua viva por
 * compatibilidade: o override por número ainda aponta para ela. As duas processam
 * pelo MESMO código (`lib/channels/meta/processar-evento.ts`).
 *
 * ─── Por que o tenant pode vir do corpo AQUI ────────────────────────────────
 * Só depois da assinatura HMAC-SHA256 conferir com o App Secret da instalação: ela
 * prova que a entrega saiu da Meta para este app. O número vem da Meta; QUEM é dono
 * dele vem do nosso banco, e o índice único da migration 0165 garante uma sessão
 * ativa por número. Número sem dono, ou com dono ambíguo, não é entregue a ninguém.
 *
 * ─── Respostas ──────────────────────────────────────────────────────────────
 * GET: o `hub.challenge` em TEXTO PURO (envelopar faz a verificação da Meta falhar).
 * POST: 401 assinatura, 400 corpo fora do contrato, 500 quando a busca da sessão
 * falha (a Meta reentrega — melhor que perder a mensagem com um 200), e 200 para o
 * resto, inclusive evento de número desconhecido: a Meta reentrega todo não-2xx, e
 * recusar o que não é nosso vira re-tentativa em backoff por horas.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { lerEntregaDaMeta, processarEventoDaMeta } from "@/lib/channels/meta/processar-evento";
import {
  metaSessionByPhoneNumberId,
  metaSessionsByWabaId,
  type MetaWebhookSession,
  type SessaoDoNumero,
} from "@/lib/channels/meta/session";
import { verificationChallenge, type MetaWebhookEvent } from "@/lib/channels/meta/webhook";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  // O verify token da INSTALAÇÃO: banco primeiro, `META_WEBHOOK_VERIFY_TOKEN` do
  // `.env` como piso (`lib/channels/meta/app.ts`) — o mesmo que a rota por token e
  // o registro do webhook usam. Sem nenhum configurado, recusa.
  const { verifyToken } = await appDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

function numeroDo(e: MetaWebhookEvent): string | null {
  if (e.kind === "inbound_message") return e.phoneNumberId || null;
  if (e.kind === "message_status") return e.phoneNumberId ?? null;
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const leitura = await lerEntregaDaMeta(await req.text(), req.headers.get("x-hub-signature-256"), requestId);
  if (!leitura.ok) {
    return fail(leitura.codigo, leitura.mensagem, leitura.status, {
      requestId,
      ...(leitura.detalhes !== undefined ? { details: leitura.detalhes } : {}),
    });
  }

  const eventos = leitura.eventos;
  const admin = createAdminClient();
  const agora = new Date().toISOString();
  const desfechos: string[] = [];

  // Uma entrega costuma trazer vários eventos do mesmo número: uma busca por número.
  const porNumero = new Map<string, SessaoDoNumero>();
  const porWaba = new Map<string, MetaWebhookSession[]>();

  try {
    for (const e of eventos) {
      if (e.kind === "template_status") {
        let sessoes = porWaba.get(e.wabaId);
        if (!sessoes) {
          sessoes = await metaSessionsByWabaId(admin, e.wabaId);
          porWaba.set(e.wabaId, sessoes);
        }
        if (sessoes.length === 0) {
          desfechos.push("no_session");
          continue;
        }
        for (const sessao of sessoes) await processarEventoDaMeta(admin, e, sessao, agora);
        continue;
      }

      const numero = numeroDo(e);
      if (!numero) {
        desfechos.push("no_session");
        continue;
      }
      let dono = porNumero.get(numero);
      if (!dono) {
        dono = await metaSessionByPhoneNumberId(admin, numero);
        porNumero.set(numero, dono);
      }
      if (!dono.encontrada) {
        logger.warn("[meta.webhook] evento de número sem sessão ativa", {
          request_id: requestId,
          phone_number_id: numero,
          motivo: dono.motivo,
          kind: e.kind,
        });
        desfechos.push(dono.motivo === "ambigua" ? "ambiguous_session" : "no_session");
        continue;
      }

      const desfecho = await processarEventoDaMeta(admin, e, dono.sessao, agora);
      if (desfecho && (e.kind === "inbound_message" || desfecho === "waba_divergente")) {
        desfechos.push(desfecho);
      }
    }
  } catch (err) {
    logger.error("[meta.webhook] busca da sessão falhou — a Meta vai reentregar", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "session_lookup_failed", 500, { requestId });
  }

  return NextResponse.json({ received: eventos.length, outcomes: desfechos }, { status: 200 });
}
