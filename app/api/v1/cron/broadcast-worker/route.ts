/**
 * GET/POST /api/v1/cron/broadcast-worker — o relógio dos Disparos.
 *
 * Mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET,
 * fail-closed) e a mesma régua de auditoria de `flow-worker`: só audita o tick
 * que MEXEU em algo. Um cron que roda de minuto em minuto numa instalação sem
 * disparo nenhum geraria 43.200 linhas de auditoria por mês sem ter feito nada
 * — o achado 17 de `docs/testing/user-journey-map.md`.
 *
 * A cadência de um minuto não é arbitrária: ela É o throttle. O worker manda um
 * lote fixo por tick, então o intervalo do cron define a velocidade da campanha
 * (ver o cabeçalho de `lib/disparos/worker.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { runBroadcastWorkerTick } from "@/lib/disparos/worker";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  let summary;
  try {
    summary = await runBroadcastWorkerTick(admin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[broadcast-worker.cron] runBroadcastWorkerTick threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  if (summary.claim_falhou || summary.disparos || summary.enviados || summary.falhas) {
    void audit({
      action: "broadcast.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...summary },
      requestId,
    });
  }

  return ok(summary, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
