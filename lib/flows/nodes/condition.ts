/**
 * Nó CONDITION — reusa o MESMO avaliador do motor de automação
 * (`evaluateConditions`, AND entre checks) para não ter uma segunda
 * implementação de "eq/neq/contains" divergindo da automação existente.
 * Duas saídas fixas: 'true' e 'false'.
 */
import { evaluateConditions } from "@/lib/automation/conditions";
import type { ConditionNodeConfig, FlowNodeCtx, NodeOutcome } from "@/lib/flows/types";

export function executeConditionNode(ctx: FlowNodeCtx, config: ConditionNodeConfig): NodeOutcome {
  const checks = config.checks ?? [];
  const result = checks.length === 0 ? true : evaluateConditions(checks, ctx.context);
  return { kind: "advance", handle: result ? "true" : "false" };
}
