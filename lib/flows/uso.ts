/**
 * O ESTADO DE EDIÇÃO do fluxo de um disparo — a face TypeScript de uma regra que
 * mora no banco (migration 0507, `fn_flow_estado_de_edicao_interno`).
 *
 * A regra NÃO é reimplementada aqui, e é de propósito: o banco a aplica em
 * gatilho, para todo caminho que escreve no grafo (rota, RPC, REST direta,
 * `service_role`). Uma cópia em TypeScript seria a segunda fonte da verdade que
 * diverge no primeiro ajuste. A tela e as rotas PERGUNTAM ao banco
 * (`fn_flow_estado_de_edicao`) e só traduzem a resposta.
 *
 *   editavel  — disparo `draft`/`paused` e ninguém entrou no fluxo ainda;
 *   em_uso    — disparo `scheduled`/`running`, ou contato com execução viva;
 *   historico — disparo terminado, ou a definição já foi usada.
 *
 * Fluxo de Automações (sem `broadcast_id`) fica fora: `escopo = 'automacao'` e
 * o comportamento é o de sempre (`status = 'active'` trava o canvas).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type EstadoDeEdicao = "editavel" | "em_uso" | "historico";

export interface UsoDoFluxo {
  escopo: "disparo" | "automacao";
  estado: EstadoDeEdicao | null;
  /** Execuções vivas: `running`/`waiting`, ou botão ainda clicável. */
  vivas: number;
  /** Alguma execução já existiu neste fluxo. */
  usado: boolean;
  disparo_status: string | null;
}

/** O banco responde; `null` quando o fluxo não existe ou não é da organização de quem pergunta. */
export async function usoDoFluxo(db: SupabaseClient, flowId: string): Promise<UsoDoFluxo | null> {
  const { data, error } = await db.rpc("fn_flow_estado_de_edicao", { p_flow: flowId });
  if (error) throw new Error(`uso_do_fluxo: ${error.message}`);
  return (data as UsoDoFluxo | null) ?? null;
}

/**
 * O canvas fica somente leitura? Fluxo de disparo: quando não está `editavel`.
 * Fluxo de Automações: quando está ativo, como sempre foi.
 */
export function canvasSomenteLeitura(
  flow: { status?: string | null; broadcast_id?: string | null } | null | undefined,
  uso: UsoDoFluxo | null | undefined,
): boolean {
  if (!flow) return false;
  if (flow.broadcast_id) return (uso?.estado ?? "historico") !== "editavel";
  return flow.status === "active";
}

/**
 * A recusa do banco (`PT409`) — `flow_protegido:<estado>` ou
 * `disparo_com_historico` — vira algo que a rota sabe responder. Qualquer outro
 * erro devolve `null`, e a rota segue tratando como antes.
 */
export function recusaDeProtecao(
  err: { code?: string | null; message?: string | null } | null | undefined,
): { tipo: "flow_protegido"; estado: EstadoDeEdicao } | { tipo: "disparo_com_historico" } | null {
  if (!err || err.code !== "PT409") return null;
  const msg = err.message ?? "";
  if (msg.startsWith("disparo_com_historico")) return { tipo: "disparo_com_historico" };
  const m = /^flow_protegido:(editavel|em_uso|historico)/.exec(msg);
  if (m) return { tipo: "flow_protegido", estado: m[1] as EstadoDeEdicao };
  return null;
}

/** A frase de cada estado, para resposta de API e aviso de tela (chave do dicionário). */
export const FRASE_DO_ESTADO: Record<Exclude<EstadoDeEdicao, "editavel">, string> = {
  em_uso:
    "Este fluxo está em uso: há contatos dentro dele agora. Ele não pode ser editado — duplique o disparo para editar uma cópia.",
  historico:
    "Esta é a definição que o disparo usou. Ela fica como histórico e não pode ser editada — duplique o disparo para editar uma cópia.",
};
