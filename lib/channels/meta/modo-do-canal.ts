/**
 * O MODO de um canal oficial: número só na Cloud API, ou número que continua no
 * aplicativo WhatsApp Business ao mesmo tempo (coexistência).
 *
 * O vocabulário é o do CHECK de `channel_sessions.meta_modo` (migration 0417), e
 * o par é cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 *
 * ─── Quem decide é a META, nunca o navegador ────────────────────────────────
 * O Cadastro Incorporado termina com um evento (`FINISH` ou
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) que chega pelo `postMessage` — e
 * qualquer janela manda `postMessage`. Gravar o modo a partir dele deixaria o
 * cliente escrever no banco o que quisesse. O CRM pergunta ao número
 * (`is_on_biz_app`) e grava a resposta; o evento vira só rótulo de auditoria.
 */
export const MODOS_DO_CANAL_OFICIAL = ["cloud_api", "coexistencia"] as const;

export type ModoDoCanalOficial = (typeof MODOS_DO_CANAL_OFICIAL)[number];

/**
 * O modo a partir do que a Meta respondeu. `null` quando a pergunta não teve
 * resposta — "não sei" não vira `cloud_api`: um número em coexistência gravado
 * como dedicado esconderia do operador justamente o que ele precisa saber.
 */
export function modoPelaResposta(isOnBizApp: boolean | null): ModoDoCanalOficial | null {
  if (isOnBizApp === null) return null;
  return isOnBizApp ? "coexistencia" : "cloud_api";
}
