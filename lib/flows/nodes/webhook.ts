/**
 * Nó WEBHOOK — reusa `executeCallWebhook` (lib/automation/actions/call-webhook.ts)
 * inteiro: anti-SSRF (assertSafeOutboundUrl + resolução de DNS real), HMAC
 * SHA256 opcional, retry 3x, projeção de campos públicos. Nenhuma segunda
 * implementação de "mandar webhook pra fora" — é exatamente o caminho que
 * N8N do outro lado vai receber.
 */
import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import type { ActionCtx } from "@/lib/automation/types";
import type { FlowNodeCtx, NodeOutcome, WebhookNodeConfig } from "@/lib/flows/types";

function asActionCtx(ctx: FlowNodeCtx): ActionCtx {
  return ctx;
}

export async function executeWebhookNode(ctx: FlowNodeCtx, config: WebhookNodeConfig): Promise<NodeOutcome> {
  if (!config.url) return { kind: "failed", error: "missing_url" };
  const result = await executeCallWebhook(asActionCtx(ctx), { url: config.url, secret: config.secret });
  if (result.status === "failed") return { kind: "failed", error: result.error ?? "webhook_failed" };
  return { kind: "advance" };
}
