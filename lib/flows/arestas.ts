/**
 * AS ARESTAS DO CANVAS — quem liga e quem desliga.
 *
 * ─── Uma saída leva a UM destino ────────────────────────────────────────────
 *
 * O motor segue UMA aresta por saída (`nextNode` em `lib/flows/graph.ts` faz
 * `find`): duas arestas na mesma saída não são "dois caminhos", são um caminho
 * escolhido pela ordem do array e outro morto. Por isso ligar numa saída que
 * já tem destino SUBSTITUI a aresta antiga — senão "apaguei A→B e liguei A→C"
 * deixava A→B viva e o contato seguia por ela.
 *
 * A saída é o par (nó de origem, `sourceHandle`): `null` é a saída padrão
 * (a saída única de quem não tem botões), `true` e `false` são as da
 * condição, `button:<i>` a do i-ésimo botão da mensagem.
 */

export interface ArestaDoCanvas {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

const saida = (handle: string | null | undefined): string | null => handle ?? null;

/** A aresta sai desta saída? */
export function saiDe(aresta: ArestaDoCanvas, origem: string, handle: string | null | undefined): boolean {
  return aresta.source === origem && saida(aresta.sourceHandle) === saida(handle);
}

/** A saída ainda não leva a lugar nenhum. */
export function saidaLivre(arestas: ArestaDoCanvas[], origem: string, handle: string | null | undefined): boolean {
  return !arestas.some((a) => saiDe(a, origem, handle));
}

/**
 * Liga a saída da `nova` ao destino dela. Se a saída já levava a outro nó, a
 * ligação antiga sai — uma saída, um destino.
 */
export function conectarSaida<A extends ArestaDoCanvas>(arestas: A[], nova: A): A[] {
  return [...arestas.filter((a) => !saiDe(a, nova.source, nova.sourceHandle)), nova];
}

/** Tira só as arestas pedidas. Os nós não são tocados. */
export function removerArestas<A extends ArestaDoCanvas>(arestas: A[], ids: Iterable<string>): A[] {
  const fora = new Set(ids);
  return arestas.filter((a) => !fora.has(a.id));
}
