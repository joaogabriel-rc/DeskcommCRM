import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A ARESTA APAGADA NO CANVAS SAI DO BANCO — E NÃO VOLTA.
 *
 * O construtor grava o grafo INTEIRO a cada "Salvar"
 * (`PUT /api/v1/flows/:id/graph` → `fn_flow_replace_graph`). Apagar uma linha
 * na tela só é exclusão de verdade se a função SUBSTITUIR as arestas — se ela
 * somasse, ou preservasse as que não vieram, a linha apagada voltaria no
 * próximo carregamento. Este arquivo prova isso no Postgres, como o PostgREST
 * chama (papel `authenticated` + claims), com o ciclo que o operador faz:
 *
 *   salva A→B · salva sem A→B · confere que sumiu e que os nós ficaram ·
 *   salva A→C · salva de novo igual · só A→C existe.
 *
 * O lado da tela (estado, poda, saída ocupada) é provado em
 * `tests/unit/fluxo-excluir-aresta.test.ts` e no e2e
 * `tests/e2e/fluxo-apagar-aresta.spec.ts`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ultima = (saida: string): string => saida.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "";

const ORG = "a0000000-0000-4000-8000-0000000ae1a0";
const MGR = "a1111111-0000-4000-8000-0000000ae1a0";
const FLOW = "aaaa0000-0000-4000-8000-0000000ae1a0";
const T = "aaaa1111-0000-4000-8000-0000000ae1a1";
const A = "aaaa1111-0000-4000-8000-0000000ae1a2";
const B = "aaaa1111-0000-4000-8000-0000000ae1a3";
const C = "aaaa1111-0000-4000-8000-0000000ae1a4";
const E_TA = "eeee0000-0000-4000-8000-0000000ae1a1";
const E_AB = "eeee0000-0000-4000-8000-0000000ae1a2";
const E_AC = "eeee0000-0000-4000-8000-0000000ae1a3";
const E_BOTAO = "eeee0000-0000-4000-8000-0000000ae1a4";

const NOS = JSON.stringify([
  { id: T, type: "TRIGGER", label: "Quando…", config: { trigger_type: "contact_tag_added" }, position_x: 0, position_y: 0 },
  {
    id: A,
    type: "MESSAGE",
    label: "Mensagem",
    config: {
      window_mode: "inside_24h",
      blocks: [{ id: "t1", tipo: "texto", texto: "Posso confirmar?", botoes: [{ id: "b1", rotulo: "Sim", acao: "fluxo" }] }],
    },
    position_x: 300,
    position_y: 0,
  },
  { id: B, type: "END", label: "Fim B", config: {}, position_x: 600, position_y: 0 },
  { id: C, type: "END", label: "Fim C", config: {}, position_x: 600, position_y: 200 },
]);

const ar = (id: string, de: string, para: string, handle: string | null = null) => ({
  id,
  source_node_id: de,
  target_node_id: para,
  source_handle: handle,
});

/** O save do canvas, como o PostgREST chama a RPC. */
function salvar(arestas: Array<ReturnType<typeof ar>>): void {
  sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${MGR}"}', false);
    select public.fn_flow_replace_graph('${FLOW}'::uuid, '${ORG}'::uuid, '${NOS}'::jsonb, '${JSON.stringify(arestas)}'::jsonb);
  `);
}

/** O que a página carrega ao reabrir: as arestas do fluxo, ordenadas. */
function arestasGravadas(): string[] {
  return sql(`
    select source_node_id || '>' || target_node_id || ':' || coalesce(source_handle, 'padrao')
      from public.flow_edges where flow_id = '${FLOW}'::uuid order by 1;
  `)
    .split("\n")
    .filter(Boolean)
    .sort(); // ordem do JS, não a collation do banco: as duas listas comparadas usam a mesma régua
}

const nosGravados = (): number =>
  Number(ultima(sql(`select count(*) from public.flow_nodes where flow_id = '${FLOW}'::uuid;`)));

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MGR}', 'flow-aresta@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'flow-aresta', 'Flow Aresta', 'Flow Aresta') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MGR}', '${ORG}', 'manager', now()) on conflict do nothing;
    insert into public.flows (id, organization_id, name, trigger_type, trigger_config)
      values ('${FLOW}', '${ORG}', 'fluxo da aresta', 'contact_tag_added', '{"tag":"x"}'::jsonb) on conflict (id) do nothing;
  `);
});

describe("apagar uma aresta persiste no banco", () => {
  it("A→B gravada (controle positivo: sem ele, uma função que não grava nada passaria)", () => {
    salvar([ar(E_TA, T, A), ar(E_AB, A, B), ar(E_BOTAO, A, C, "button:b1")]);
    expect(arestasGravadas()).toEqual([`${A}>${B}:padrao`, `${A}>${C}:button:b1`, `${T}>${A}:padrao`].sort());
  });

  it("salvar SEM A→B a tira do banco — e os quatro nós continuam", () => {
    salvar([ar(E_TA, T, A), ar(E_BOTAO, A, C, "button:b1")]);
    expect(arestasGravadas()).not.toContain(`${A}>${B}:padrao`);
    expect(nosGravados()).toBe(4);
  });

  it("apagar a aresta do BOTÃO não apaga o botão: o nó volta com a config intacta", () => {
    salvar([ar(E_TA, T, A)]);
    expect(arestasGravadas()).toEqual([`${T}>${A}:padrao`]);
    const botoes = ultima(
      sql(`select jsonb_array_length(config->'blocks'->0->'botoes') from public.flow_nodes where id = '${A}'::uuid;`),
    );
    expect(botoes).toBe("1");
  });

  it("ligar A→C e salvar de novo (o reabrir+salvar) mantém SÓ A→C — A→B não volta", () => {
    salvar([ar(E_TA, T, A), ar(E_AC, A, C)]);
    salvar([ar(E_TA, T, A), ar(E_AC, A, C)]);
    expect(arestasGravadas()).toEqual([`${A}>${C}:padrao`, `${T}>${A}:padrao`].sort());
    expect(nosGravados()).toBe(4);
  });
});
