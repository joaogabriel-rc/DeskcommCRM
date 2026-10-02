import { describe, expect, it } from "vitest";

import { fromReactFlow, type RFEdge, type RFNode } from "@/lib/flows/ui-mappers";
import { randomId } from "@/lib/random-id";
import { replaceFlowGraphSchema } from "@/lib/schemas/flows";

/**
 * A SAÍDA DE UM BOTÃO CRIADO PELA TELA PRECISA SER GRAVÁVEL.
 *
 * O editor de blocos cria o id do botão com `randomId()` — um UUID —, e a
 * saída dele no grafo é `button:<uuid>`: 43 caracteres. O schema do
 * `PUT /api/v1/flows/:id/graph` aceitava no máximo 40, então ligar a saída de
 * qualquer botão criado pela tela e clicar em "Salvar" respondia
 * "Dados inválidos" (400). Os testes não pegavam porque todos semeavam ids
 * curtos (`b1`, `button:0`).
 *
 * A régua agora é o FORMATO das saídas que existem — `null`, `true`/`false`
 * e `button:<id>` —, não um comprimento arbitrário.
 */

const UUID = "0c09c90b-e806-442d-9442-7f17a4e9e51c";

function grafoCom(sourceHandle: string | null | undefined) {
  const a = randomId();
  const b = randomId();
  return {
    nodes: [
      { id: a, type: "MESSAGE", label: "A", config: {}, position_x: 0, position_y: 0 },
      { id: b, type: "END", label: "B", config: {}, position_x: 0, position_y: 0 },
    ],
    edges: [{ id: randomId(), source_node_id: a, target_node_id: b, source_handle: sourceHandle }],
  };
}

const aceita = (h: string | null | undefined) => replaceFlowGraphSchema.safeParse(grafoCom(h)).success;

describe("saída de aresta (source_handle) no salvamento do grafo", () => {
  it("aceita button:<UUID> de 43 caracteres — o botão criado pelo editor de blocos", () => {
    const handle = `button:${UUID}`;
    expect(handle).toHaveLength(43);
    expect(aceita(handle)).toBe(true);
  });

  it("aceita os formatos antigos: saída padrão, condição e botão por índice", () => {
    for (const h of [null, undefined, "true", "false", "button:0", "button:1", "button:12"]) {
      expect(aceita(h), String(h)).toBe(true);
    }
  });

  it("aceita ids curtos de botão usados pelas fixtures e pela conversão do formato antigo", () => {
    for (const h of ["button:b1", "button:ok", "button:legado", "button:a_b-1"]) {
      expect(aceita(h), h).toBe(true);
    }
  });

  it("recusa o que não é saída de nó", () => {
    for (const h of ["", "button:", "foo", "True", "true ", "button:a b", "button:ç", `button:${"x".repeat(65)}`]) {
      expect(aceita(h), JSON.stringify(h)).toBe(false);
    }
  });

  it("o grafo que o canvas monta ao ligar um botão criado pela tela passa na validação", () => {
    const t = randomId();
    const a = randomId();
    const b = randomId();
    const botao = randomId(); // como o EditorDeBlocos cria
    const nos: RFNode[] = [
      { id: t, type: "TRIGGER", position: { x: 0, y: 0 }, data: { label: "Quando…", config: {} } },
      {
        id: a,
        type: "MESSAGE",
        position: { x: 0, y: 0 },
        data: {
          label: "Mensagem",
          config: {
            window_mode: "inside_24h",
            blocks: [{ id: randomId(), tipo: "texto", texto: "Oi", botoes: [{ id: botao, rotulo: "Sim", acao: "fluxo" }] }],
          },
        },
      },
      { id: b, type: "END", position: { x: 0, y: 0 }, data: { label: "Fim", config: {} } },
    ];
    const arestas: RFEdge[] = [
      { id: randomId(), source: t, target: a, sourceHandle: null },
      { id: randomId(), source: a, target: b, sourceHandle: `button:${botao}` },
    ];
    const r = replaceFlowGraphSchema.safeParse(fromReactFlow(nos, arestas));
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});
