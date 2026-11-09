/**
 * A REAÇÃO de uma mensagem — o emoji e a mensagem reagida.
 *
 * O canal oficial grava `metadata.reaction = { emoji, message_id }`, onde
 * `message_id` é o `wamid` (`external_id`) da mensagem reagida. Emoji `null` é a
 * reação REMOVIDA. A bolha não faz join: acha a mensagem reagida na lista já
 * carregada da conversa, pelo `external_id`.
 *
 * Valida a forma em vez de confiar no `jsonb`: um valor estranho vira `null` e a
 * bolha cai no desenho comum, nunca quebra a conversa.
 */
export interface Reacao {
  emoji: string | null;
  /** `external_id` da mensagem reagida. */
  alvoExternalId: string | null;
}

export function lerReacao(metadata: Record<string, unknown> | null | undefined): Reacao | null {
  const bruto = metadata?.reaction;
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const r = bruto as Record<string, unknown>;
  const emoji = typeof r.emoji === "string" && r.emoji.trim() ? r.emoji.trim().slice(0, 16) : null;
  const alvo = typeof r.message_id === "string" && r.message_id.trim() ? r.message_id.trim() : null;
  if (emoji === null && alvo === null) return null;
  return { emoji, alvoExternalId: alvo };
}
