/**
 * AS ARESTAS DO CANVAS — quem liga, quem desliga e quem limpa.
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
 * (o "Próximo passo" do nó de mensagem, a saída única dos demais), `true` e
 * `false` são as da condição, `button:<id>` a de um botão de fluxo.
 *
 * ─── Aresta de botão que não existe mais ────────────────────────────────────
 *
 * Remover o botão, ou trocá-lo para "Abrir site", tira a saída `button:<id>`
 * do card — e o React Flow para de DESENHAR a aresta, mas ela continuava no
 * estado e era gravada assim. Invisível, ninguém conseguia apagá-la, e voltar
 * o botão para "fluxo" fazia a ligação antiga reaparecer sozinha. Aqui ela é
 * podada de verdade: some do estado, e o save seguinte a tira do banco.
 *
 * A poda é deliberadamente estreita — só `button:*` de nó de mensagem, a
 * mesma régua das saídas que o card desenha (`saidasDeBotao`). Aresta de
 * outro tipo de saída nunca é tocada aqui.
 */
import { saidasDeBotao } from "@/lib/flows/blocos";
import type { MessageNodeConfig } from "@/lib/flows/types";

export interface ArestaDoCanvas {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface NoDoCanvas {
  id: string;
  type?: string;
  data: { config: Record<string, unknown> };
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

/**
 * As arestas de botão cujo botão não é mais saída de fluxo — removido, ou
 * virou link. Devolve o MESMO array quando não há o que podar, para o
 * `setEdges` não provocar render à toa.
 */
export function podarArestasDeBotaoOrfas<A extends ArestaDoCanvas>(nos: NoDoCanvas[], arestas: A[]): A[] {
  const mensagens = new Map(nos.filter((n) => n.type === "MESSAGE").map((n) => [n.id, n]));
  const validas = new Map<string, Set<string>>();
  const orfa = (a: A): boolean => {
    const handle = saida(a.sourceHandle);
    if (!handle?.startsWith("button:")) return false;
    const no = mensagens.get(a.source);
    if (!no) return false;
    let deste = validas.get(no.id);
    if (!deste) {
      deste = new Set(saidasDeBotao(no.data.config as MessageNodeConfig).map((s) => s.handle));
      validas.set(no.id, deste);
    }
    return !deste.has(handle);
  };
  return arestas.some(orfa) ? arestas.filter((a) => !orfa(a)) : arestas;
}
