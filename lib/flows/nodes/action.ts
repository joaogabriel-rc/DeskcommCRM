/**
 * Nó ACTION — não reimplementa add_tag/remove_tag/assign_owner/
 * create_or_move_lead/update_custom_field: chama o MESMO registry de
 * executores do motor de automação (`getAction`), com `ctx` compatível
 * (FlowNodeCtx === ActionCtx estruturalmente). Um executor novo aqui é um
 * executor novo lá, automaticamente disponível nos dois motores.
 *
 * ═══ Várias ações no mesmo nó, na ORDEM configurada ═══
 *
 * O nó executa a lista de cima para baixo e PARA na primeira que falhar. Parar
 * é a decisão certa e não é óbvia: as ações de um nó costumam ser uma sequência
 * dependente — "define o produto de interesse, define a origem, marca a tag" —
 * e a mensagem seguinte lê justamente esses valores. Seguir depois de uma falha
 * mandaria a mensagem com metade das variáveis vazias, que é pior que não
 * mandar: o contato recebe "Seu produto de interesse é:" e nada.
 *
 * Cada ação enriquece `ctx.context` ao gravar (ver `update-custom-field.ts`),
 * então a ação seguinte — e o nó de mensagem depois dela — já enxerga o valor
 * novo sem reler o contato do banco.
 */
import "@/lib/automation/actions/register-all";
import { getAction } from "@/lib/automation/actions";
import { acoesDoNo } from "@/lib/flows/acoes";
import type { ActionCtx } from "@/lib/automation/types";
import type {
  ActionNodeConfig,
  FlowNodeCtx,
  NodeOutcome,
} from "@/lib/flows/types";

function asActionCtx(ctx: FlowNodeCtx): ActionCtx {
  return ctx;
}

export async function executeActionNode(ctx: FlowNodeCtx, config: ActionNodeConfig): Promise<NodeOutcome> {
  const acoes = acoesDoNo(config);
  if (acoes.length === 0) return { kind: "failed", error: "missing_action_type" };

  for (const [indice, acao] of acoes.entries()) {
    const executor = getAction(acao.action_type);
    if (!executor) return { kind: "failed", error: `unknown_action:${acao.action_type}` };

    const result = await executor.execute(asActionCtx(ctx), acao.config ?? {});
    if (result.status === "failed") {
      // O índice entra no motivo porque, num nó com cinco ações, "action_failed"
      // não diz qual — e o operador só vê esta string, em `last_error`.
      return {
        kind: "failed",
        error: `acao_${indice + 1}_${acao.action_type}: ${result.error ?? "action_failed"}`,
      };
    }
  }
  return { kind: "advance" };
}
