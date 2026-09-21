/**
 * GET/POST /api/v1/cron/flow-worker — relógio do nó DELAY do Flow Builder.
 *
 * Drena execuções due de `flow_executions` via `runFlowWorkerTick`
 * (lib/flows/engine.ts), mesmo contrato dos demais crons (Bearer
 * INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed). Só audita tick que
 * mexeu em algo — mesma régua de `followup-flow-worker` (CLAUDE.md: cron que
 * não fez nada não é mutação).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFlowWorkerTick } from "@/lib/flows/engine";

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
    summary = await runFlowWorkerTick(admin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[flow-worker.cron] runFlowWorkerTick threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  if (summary.claim_falhou || summary.claimed || summary.resumed || summary.failed) {
    void audit({
      action: "flows.worker_run",
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
