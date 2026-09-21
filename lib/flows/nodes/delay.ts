/**
 * Nó DELAY — NUNCA bloqueia o worker: devolve `wait_delay` com o instante em
 * que o relógio (cron/flow-worker + fn_claim_due_flow_executions) deve
 * retomar. Mesmo padrão de `lib/followup/engine.ts` (next_eval_at).
 */
import type { DelayNodeConfig, NodeOutcome } from "@/lib/flows/types";

const MIN_DELAY_MS = 1_000;
const DEFAULT_DELAY_MS = 5 * 60 * 1000;

export function executeDelayNode(config: DelayNodeConfig, now: () => Date = () => new Date()): NodeOutcome {
  const ms = Math.max(MIN_DELAY_MS, Number(config.duration_ms) || DEFAULT_DELAY_MS);
  return { kind: "wait_delay", until: new Date(now().getTime() + ms).toISOString() };
}
