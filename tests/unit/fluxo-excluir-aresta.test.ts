import { describe, expect, it } from "vitest";

import { conectarSaida, removerArestas, saidaLivre } from "@/lib/flows/arestas";
import { nextNode } from "@/lib/flows/graph";
import type { FlowEdgeRow, FlowNodeRow } from "@/lib/flows/types";
import { fromReactFlow, toReactFlow, type RFEdge, type RFNode } from "@/lib/flows/ui-mappers";

/**
 * APAGAR SÓ A LINHA — e ela não volta.
 *
 * O canvas guarda nós e arestas em estado do React Flow e grava o grafo
 * INTEIRO a cada "Salvar" (`PUT /flows/:id/graph` → `fn_flow_replace_graph`,
 * que apaga as arestas do fluxo e insere exatamente as recebidas). Por isso
 * "persistido" aqui é o ciclo real: estado → `fromReactFlow` → banco que
 * SUBSTITUI → `toReactFlow` (o que a página carrega ao reabrir). O lado SQL da
 * substituição é provado em `tests/invariants/flow-aresta-apagada-nao-volta.test.ts`.
 *
 * Os defeitos que este arquivo prende:
 *   - ligar numa saída ocupada SOMAVA uma segunda aresta (o motor seguia a
 *     primeira, então "apaguei A→B e liguei A→C" podia seguir por A→B);
 *   - o "+" ligava o passo novo mesmo com a saída padrão já ocupada.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const T = "dddddddd-0000-4000-8000-000000000004";

function no(id: string, type: RFNode["type"], config: Record<string, unknown> = {}): RFNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id.slice(0, 4), config } };
}
function aresta(id: string, source: string, target: string, sourceHandle: string | null = null): RFEdge {
  return { id, source, target, sourceHandle };
}

/** Mensagem com dois botões: `button:0` ("Sim") e `button:1` ("Não"). */
const mensagemComBotoes = () => no(A, "MESSAGE", { body: "Posso confirmar?", buttons: [{ label: "Sim" }, { label: "Não" }] });

/** O banco do canvas: o save SUBSTITUI o grafo inteiro, como `fn_flow_replace_graph`. */
function bancoDoFluxo(nodes: FlowNodeRow[] = [], edges: FlowEdgeRow[] = []) {
  let gravado = { nodes, edges };
  return {
    salvar(rfNodes: RFNode[], rfEdges: RFEdge[]) {
      const g = fromReactFlow(rfNodes, rfEdges);
      gravado = { nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges.map((e) => ({ ...e })) };
    },
    reabrir() {
      return toReactFlow(gravado.nodes, gravado.edges);
    },
    get arestas() {
      return gravado.edges;
    },
  };
}

describe("apagar uma aresta do construtor de fluxo", () => {
  const nos = [no(T, "TRIGGER"), no(A, "MESSAGE", { body: "Olá" }), no(B, "END"), no(C, "END")];

  it("1-3 · A→B é criada, identificada pelo id e apagada sozinha", () => {
    const ab = aresta("e-ab", A, B);
    let arestas = conectarSaida([aresta("e-ta", T, A)], ab);
    expect(arestas.map((e) => e.id)).toEqual(["e-ta", "e-ab"]);
    // selecionar = apontar a aresta pelo id; é o que a lixeira e o teclado mandam
    expect(arestas.find((e) => e.id === "e-ab")).toMatchObject({ source: A, target: B });

    arestas = removerArestas(arestas, ["e-ab"]);
    expect(arestas.map((e) => e.id)).toEqual(["e-ta"]);
  });

  it("4-5 · depois de apagar, A e B seguem no grafo e a saída de A fica livre", () => {
    const arestas = removerArestas([aresta("e-ta", T, A), aresta("e-ab", A, B)], ["e-ab"]);
    expect(nos.map((n) => n.id)).toEqual([T, A, B, C]); // remover aresta não mexe em nó
    expect(arestas.some((e) => e.source === A)).toBe(false);
    expect(saidaLivre(arestas, A, null)).toBe(true);
  });

  it("6-9 · persistido sem A→B, reaberto sem A→B; A→C liga e sobrevive a salvar e reabrir", () => {
    const banco = bancoDoFluxo();
    let arestas: RFEdge[] = [aresta("e-ta", T, A), aresta("e-ab", A, B)];
    banco.salvar(nos, arestas);
    expect(banco.arestas.map((e) => e.id)).toContain("e-ab");

    arestas = removerArestas(arestas, ["e-ab"]);
    banco.salvar(nos, arestas);
    expect(banco.arestas.find((e) => e.source_node_id === A && e.target_node_id === B)).toBeUndefined();

    const reaberto = banco.reabrir();
    expect(reaberto.edges.find((e) => e.source === A && e.target === B)).toBeUndefined();
    expect(reaberto.nodes.map((n) => n.id).sort()).toEqual([A, B, C, T].sort());

    arestas = conectarSaida(reaberto.edges, aresta("e-ac", A, C));
    banco.salvar(reaberto.nodes, arestas);
    // salvar de novo (o "Salvar" repetido, ou o reabrir+salvar) não ressuscita nada
    banco.salvar(banco.reabrir().nodes, banco.reabrir().edges);
    const final = banco.reabrir().edges.filter((e) => e.source === A);
    expect(final).toEqual([expect.objectContaining({ id: "e-ac", source: A, target: C, sourceHandle: null })]);
  });

  it("ligar numa saída OCUPADA troca o destino — A→B não sobra ao ligar A→C", () => {
    const arestas = conectarSaida([aresta("e-ab", A, B)], aresta("e-ac", A, C));
    expect(arestas).toEqual([expect.objectContaining({ id: "e-ac", target: C })]);
  });

  it("trocar o destino de uma saída não mexe nas OUTRAS saídas do mesmo nó", () => {
    const antes = [aresta("e-sim", A, B, "button:0"), aresta("e-nao", A, B, "button:1")];
    const depois = conectarSaida(antes, aresta("e-nao2", A, C, "button:1"));
    expect(depois.map((e) => e.id)).toEqual(["e-sim", "e-nao2"]);
    const cond = conectarSaida([aresta("e-t", A, B, "true"), aresta("e-f", A, C, "false")], aresta("e-t2", A, C, "true"));
    expect(cond.map((e) => `${e.id}:${e.sourceHandle}`)).toEqual(["e-f:false", "e-t2:true"]);
  });

  it("10 · apagar a aresta de um botão não apaga o botão nem o nó", () => {
    const banco = bancoDoFluxo();
    const arestas = removerArestas([aresta("e-sim", A, B, "button:0"), aresta("e-nao", A, C, "button:1")], ["e-sim"]);
    banco.salvar([mensagemComBotoes(), no(B, "END"), no(C, "END")], arestas);
    const reaberto = banco.reabrir();
    const noA = reaberto.nodes.find((n) => n.id === A)!;
    expect(noA.data.config.buttons as unknown[]).toHaveLength(2);
    expect(reaberto.edges.map((e) => e.id)).toEqual(["e-nao"]);
    expect(saidaLivre(reaberto.edges, A, "button:0")).toBe(true);
  });

  it("11 · apagar a saída única não apaga o nó, e o motor para ali", () => {
    const arestas = removerArestas([aresta("e-ab", A, B)], ["e-ab"]);
    const g = fromReactFlow([no(A, "MESSAGE", { body: "Oi" }), no(B, "END")], arestas);
    const grafo = {
      nodesById: new Map(g.nodes.map((n) => [n.id, n])),
      edgesBySource: new Map([[A, g.edges]]),
    };
    expect(grafo.nodesById.has(A)).toBe(true);
    expect(nextNode(grafo, A, null)).toBeNull();
  });

  it("12-13 · fluxos antigos abrem com todas as arestas: botão por índice, modelo, condição e padrão", () => {
    const legado = no(A, "MESSAGE", { body: "Oi", buttons: [{ label: "Sim" }, { label: "Não" }] });
    const modelo = no(B, "MESSAGE", {
      window_mode: "outside_24h",
      template_name: "pedido",
      buttons: [{ label: "Confirmar" }],
    });
    const cond = no(C, "CONDITION", {});
    const arestas = [
      aresta("e1", T, A),
      aresta("e2", A, B, "button:0"),
      aresta("e3", A, C, "button:1"),
      aresta("e4", B, C, "button:0"),
      aresta("e5", C, A, "true"),
      aresta("e6", C, B, "false"),
    ];
    const banco = bancoDoFluxo();
    banco.salvar([no(T, "TRIGGER"), legado, modelo, cond], arestas);
    const reaberto = banco.reabrir();
    expect(reaberto.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle ?? null])).toEqual(
      arestas.map((e) => [e.id, e.source, e.target, e.sourceHandle ?? null]),
    );
  });
});
