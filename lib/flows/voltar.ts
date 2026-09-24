/**
 * Para onde o "‹ voltar" do construtor leva.
 *
 * O construtor é UM só (Rodada 2): abre fluxos de Automações e o fluxo próprio
 * de um disparo (`flows.broadcast_id`, migration 0399). O caminho de volta
 * acompanha o dono — o fluxo de um disparo não aparece em Automações, então
 * voltar para lá deixaria o operador numa lista onde o que ele editava não está.
 */
export interface DestinoDeVolta {
  href: string;
  rotulo: "Fluxos" | "Disparo";
}

export function voltarDoFluxo(flow: { broadcast_id?: string | null }): DestinoDeVolta {
  if (flow.broadcast_id) return { href: `/app/disparos/${flow.broadcast_id}`, rotulo: "Disparo" };
  return { href: "/app/flows", rotulo: "Fluxos" };
}
