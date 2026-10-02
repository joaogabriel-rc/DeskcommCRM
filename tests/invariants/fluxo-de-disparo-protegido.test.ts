import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * 0507 · O FLUXO DE UM DISPARO CONGELA QUANDO É USADO — E O DISPARO SE DUPLICA.
 *
 * O defeito: `fn_flow_replace_graph` apaga e reinsere o grafo, e as referências
 * do histórico são `on delete set null`. Reescrever o grafo de um fluxo já usado
 * anula o rastro de toda execução (caso "a demonstração", abaixo, roda isso num
 * fluxo de Automações, que esta entrega não protege). A única trava era a ROTA;
 * a RLS deixa o gestor escrever direto, e `service_role` não passa por RLS.
 *
 * O que este arquivo prova, no banco que o self-host aplica (o baseline):
 *   1. a MATRIZ inteira de estados da regra única;
 *   2. o fluxo protegido recusa a RPC, a escrita REST direta (nós, arestas e
 *      a definição em `flows`) e o `service_role` — e o histórico fica intacto;
 *   3. o fluxo editável continua editável (controle positivo);
 *   4. o disparo com destinatário processado ou execução não se apaga; o
 *      rascunho sim, com a cascata;
 *   5. apagar a ORGANIZAÇÃO continua levando tudo (a exceção da cascata);
 *   6. isolamento entre organizações;
 *   7. duplicar copia a estrutura com ids novos e NADA da execução;
 *   8. as funções internas não ficam expostas.
 */

const P = "0507";
const id = (grupo: string, n: number) => `${P}${grupo}aa-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ORG_A = id("0a", 1);
const ORG_B = id("0b", 1);
const ORG_C = id("0c", 1);
const MGR_A = id("1a", 1);
const MGR_B = id("1b", 1);

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("a operação passou — a trava não existe neste banco");
}

function como(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false);
    ${script}
  `);
}

function comoServiceRole(script: string): string {
  return sql(`
    set role service_role;
    select set_config('request.jwt.claims', '{"role":"service_role"}', false);
    ${script}
  `);
}

const num = (out: string) => Number(lastLine(out));

/** Um disparo com fluxo de 2 nós (TRIGGER → MESSAGE) e 1 aresta. */
interface Caso {
  disparo: string;
  fluxo: string;
  noGatilho: string;
  noMensagem: string;
  aresta: string;
  contato: string;
}

let seq = 0;
function caso(org: string, status: string): Caso {
  seq += 1;
  const c: Caso = {
    disparo: id("b0", seq),
    fluxo: id("f0", seq),
    noGatilho: id("a1", seq),
    noMensagem: id("a2", seq),
    aresta: id("e0", seq),
    contato: id("c0", seq),
  };
  sql(`
    insert into public.contacts (id, organization_id, name, phone_number)
      values ('${c.contato}', '${org}', 'Contato ${seq}', '+55119${String(70000000 + seq)}');
    insert into public.broadcasts (id, organization_id, name, status)
      values ('${c.disparo}', '${org}', 'Disparo ${seq}', 'draft');
    insert into public.flows (id, organization_id, name, trigger_type, broadcast_id, status)
      values ('${c.fluxo}', '${org}', 'Fluxo ${seq}', 'broadcast', '${c.disparo}', 'draft');
    insert into public.flow_nodes (id, organization_id, flow_id, type, label, config, position_x, position_y) values
      ('${c.noGatilho}', '${org}', '${c.fluxo}', 'TRIGGER', 'Quando…', '{"trigger_type":"broadcast","config":{}}', 10, 20),
      ('${c.noMensagem}', '${org}', '${c.fluxo}', 'MESSAGE', 'Mensagem', '{"body":"oi"}', 300, 20);
    insert into public.flow_edges (id, organization_id, flow_id, source_node_id, target_node_id, source_handle)
      values ('${c.aresta}', '${org}', '${c.fluxo}', '${c.noGatilho}', '${c.noMensagem}', null);
    -- O grafo é montado com o disparo em rascunho, como a tela faz; o estado vem depois.
    update public.broadcasts set status = '${status}' where id = '${c.disparo}';
  `);
  return c;
}

/** Fabrica uma execução no fluxo (o estado que o motor deixaria). */
function execucao(org: string, c: Caso, campos: string): string {
  const exec = id("e1", ++seq);
  sql(`
    insert into public.flow_executions (id, organization_id, flow_id, contact_id, current_node_id, status)
      values ('${exec}', '${org}', '${c.fluxo}', '${c.contato}', '${c.noMensagem}', 'running');
    update public.flow_executions set ${campos} where id = '${exec}';
    insert into public.flow_execution_events (organization_id, execution_id, node_id, event_type)
      values ('${org}', '${exec}', '${c.noGatilho}', 'entered'), ('${org}', '${exec}', '${c.noMensagem}', 'entered');
  `);
  return exec;
}

function estado(c: Caso): { escopo: string; estado: string | null; vivas: number; usado: boolean } {
  return JSON.parse(lastLine(sql(`select public.fn_flow_estado_de_edicao_interno('${c.fluxo}')::text;`)));
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MGR_A}', 'mgr-a-0507@invariant.test'),
      ('${MGR_B}', 'mgr-b-0507@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0507-a', 'Org A 0507', 'Org A 0507'),
      ('${ORG_B}', 'inv-0507-b', 'Org B 0507', 'Org B 0507'),
      ('${ORG_C}', 'inv-0507-c', 'Org C 0507', 'Org C 0507')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MGR_A}', '${ORG_A}', 'manager', now()),
      ('${MGR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
});

describe("1 · a matriz de estados (fluxo de disparo)", () => {
  const futuro = "now() + interval '2 days'";
  const passado = "now() - interval '1 minute'";
  const linhas: Array<[string, string, string | null, string]> = [
    // [descrição, status do disparo, execução (set ...) ou null, estado esperado]
    ["rascunho sem execução", "draft", null, "editavel"],
    ["rascunho com execução viva (defensivo)", "draft", "status = 'waiting', waiting_for = 'delay'", "em_uso"],
    ["rascunho já usado, nada vivo (defensivo)", "draft", "status = 'completed'", "historico"],
    ["agendado sem execução", "scheduled", null, "em_uso"],
    ["em andamento sem execução", "running", null, "em_uso"],
    ["em andamento com execução", "running", "status = 'running'", "em_uso"],
    ["pausado sem execução", "paused", null, "editavel"],
    ["pausado com execução running", "paused", "status = 'running'", "em_uso"],
    ["pausado esperando atraso", "paused", "status = 'waiting', waiting_for = 'delay'", "em_uso"],
    ["pausado esperando botão", "paused", "status = 'waiting', waiting_for = 'button_reply'", "em_uso"],
    [
      "pausado, concluída com botão clicável",
      "paused",
      `status = 'completed', listening_node_id = current_node_id, listening_until = ${futuro}`,
      "em_uso",
    ],
    [
      "pausado, concluída com escuta vencida",
      "paused",
      `status = 'completed', listening_node_id = current_node_id, listening_until = ${passado}`,
      "historico",
    ],
    ["pausado, execução que falhou", "paused", "status = 'failed'", "historico"],
    ["pausado, execução cancelada", "paused", "status = 'cancelled'", "historico"],
    ["concluído sem execução", "completed", null, "historico"],
    ["concluído com execução esperando botão", "completed", "status = 'waiting', waiting_for = 'button_reply'", "historico"],
    ["cancelado", "cancelled", null, "historico"],
    ["falhou", "failed", null, "historico"],
  ];

  it.each(linhas)("%s → %s/%s ⇒ %s", (_d, status, exec, esperado) => {
    const c = caso(ORG_A, status);
    if (exec) execucao(ORG_A, c, exec);
    const e = estado(c);
    expect(e.escopo).toBe("disparo");
    expect(e.estado).toBe(esperado);
  });

  it("fluxo de Automações fica FORA da regra (escopo automacao, sem estado)", () => {
    const f = id("fa", 1);
    sql(`insert into public.flows (id, organization_id, name, status, trigger_type) values ('${f}', '${ORG_A}', 'Automação', 'active', 'contact_created');`);
    expect(JSON.parse(lastLine(sql(`select public.fn_flow_estado_de_edicao_interno('${f}')::text;`)))).toMatchObject({
      escopo: "automacao",
      estado: null,
    });
  });
});

describe("2 · fluxo protegido: nenhum caminho altera o grafo", () => {
  let hist: Caso;
  let emUso: Caso;
  const contagem = (c: Caso) =>
    sql(`select (select count(*) from public.flow_nodes where flow_id = '${c.fluxo}') || ':' ||
                (select count(*) from public.flow_edges where flow_id = '${c.fluxo}') || ':' ||
                (select count(*) from public.flow_execution_events ev join public.flow_executions e on e.id = ev.execution_id
                  where e.flow_id = '${c.fluxo}' and ev.node_id is null) || ':' ||
                (select string_agg(config::text, '|' order by id) from public.flow_nodes where flow_id = '${c.fluxo}');`);

  beforeAll(() => {
    hist = caso(ORG_A, "completed");
    execucao(ORG_A, hist, "status = 'completed'");
    emUso = caso(ORG_A, "paused");
    execucao(ORG_A, emUso, "status = 'waiting', waiting_for = 'button_reply'");
  });

  it("fn_flow_replace_graph (RPC, como o gestor) é recusada — e nada muda, nem o node_id dos eventos", () => {
    const antes = contagem(hist);
    const erro = erroDe(() =>
      como(
        MGR_A,
        `select public.fn_flow_replace_graph('${hist.fluxo}'::uuid, '${ORG_A}'::uuid,
           '[{"id":"${hist.noGatilho}","type":"TRIGGER","config":{}},{"id":"${hist.noMensagem}","type":"MESSAGE","config":{"body":"outro"}}]'::jsonb,
           '[]'::jsonb);`,
      ),
    );
    expect(erro).toContain("flow_protegido:historico");
    expect(contagem(hist)).toBe(antes);
    expect(antes.split(":")[2]).toBe("0");
  });

  it("REST direta em flow_nodes: delete, update e insert recusados", () => {
    for (const dml of [
      `delete from public.flow_nodes where id = '${hist.noMensagem}';`,
      `update public.flow_nodes set config = '{"body":"mudou"}' where id = '${hist.noMensagem}';`,
      `update public.flow_nodes set position_x = 999 where id = '${hist.noMensagem}';`,
      `insert into public.flow_nodes (organization_id, flow_id, type, config) values ('${ORG_A}', '${hist.fluxo}', 'END', '{}');`,
    ]) {
      expect(erroDe(() => como(MGR_A, dml))).toContain("flow_protegido:historico");
    }
  });

  it("REST direta em flow_edges: delete, update e insert recusados", () => {
    for (const dml of [
      `delete from public.flow_edges where id = '${hist.aresta}';`,
      `update public.flow_edges set source_handle = 'x' where id = '${hist.aresta}';`,
      `insert into public.flow_edges (organization_id, flow_id, source_node_id, target_node_id)
         values ('${ORG_A}', '${hist.fluxo}', '${hist.noMensagem}', '${hist.noGatilho}');`,
    ]) {
      expect(erroDe(() => como(MGR_A, dml))).toContain("flow_protegido:historico");
    }
  });

  it("a definição em flows: status, gatilho e exclusão recusados; o nome continua livre", () => {
    expect(erroDe(() => como(MGR_A, `update public.flows set status = 'active' where id = '${hist.fluxo}';`))).toContain(
      "flow_protegido",
    );
    expect(
      erroDe(() => como(MGR_A, `update public.flows set trigger_config = '{"x":1}' where id = '${hist.fluxo}';`)),
    ).toContain("flow_protegido");
    expect(erroDe(() => como(MGR_A, `delete from public.flows where id = '${hist.fluxo}';`))).toContain("flow_protegido");
    como(MGR_A, `update public.flows set name = 'Renomeado' where id = '${hist.fluxo}';`);
    expect(lastLine(sql(`select name from public.flows where id = '${hist.fluxo}'`))).toBe("Renomeado");
  });

  it("service_role (sem RLS) também é recusado", () => {
    expect(erroDe(() => comoServiceRole(`delete from public.flow_nodes where flow_id = '${hist.fluxo}';`))).toContain(
      "flow_protegido",
    );
    expect(
      erroDe(() => comoServiceRole(`update public.flow_edges set source_handle = 'y' where id = '${hist.aresta}';`)),
    ).toContain("flow_protegido");
    expect(
      erroDe(() =>
        comoServiceRole(
          `select public.fn_flow_replace_graph('${hist.fluxo}'::uuid, '${ORG_A}'::uuid, '[]'::jsonb, '[]'::jsonb);`,
        ),
      ),
    ).toContain("flow_protegido");
  });

  it("em uso (pausado com contato esperando botão) também é recusado, com o estado no erro", () => {
    expect(erroDe(() => como(MGR_A, `delete from public.flow_edges where id = '${emUso.aresta}';`))).toContain(
      "flow_protegido:em_uso",
    );
  });

  it("o erro sai com SQLSTATE PT409", () => {
    const out = sql(`
      do $$ begin
        delete from public.flow_nodes where id = '${hist.noMensagem}';
      exception when sqlstate 'PT409' then
        raise notice 'codigo=PT409';
      end $$;
      select 'fim';`);
    expect(out).toContain("fim");
    expect(num(sql(`select count(*) from public.flow_nodes where id = '${hist.noMensagem}'`))).toBe(1);
  });
});

describe("3 · editável continua editável (controle positivo)", () => {
  it("rascunho: a RPC reescreve o grafo e a REST direta escreve", () => {
    const c = caso(ORG_A, "draft");
    como(
      MGR_A,
      `select public.fn_flow_replace_graph('${c.fluxo}'::uuid, '${ORG_A}'::uuid,
         '[{"id":"${c.noGatilho}","type":"TRIGGER","config":{}},{"id":"${c.noMensagem}","type":"MESSAGE","config":{"body":"novo"}}]'::jsonb,
         '[{"id":"${c.aresta}","source_node_id":"${c.noGatilho}","target_node_id":"${c.noMensagem}"}]'::jsonb);`,
    );
    expect(lastLine(sql(`select config->>'body' from public.flow_nodes where id = '${c.noMensagem}'`))).toBe("novo");
    como(MGR_A, `update public.flow_nodes set position_x = 42 where id = '${c.noMensagem}';`);
    expect(lastLine(sql(`select position_x::int from public.flow_nodes where id = '${c.noMensagem}'`))).toBe("42");
  });

  it("pausado antes de qualquer contato entrar: editável", () => {
    const c = caso(ORG_A, "paused");
    como(MGR_A, `update public.flow_nodes set config = '{"body":"pausado"}' where id = '${c.noMensagem}';`);
    expect(lastLine(sql(`select config->>'body' from public.flow_nodes where id = '${c.noMensagem}'`))).toBe("pausado");
  });

  it("agendar (draft → active no fluxo, com o disparo ainda draft) continua permitido", () => {
    const c = caso(ORG_A, "draft");
    como(MGR_A, `update public.flows set status = 'active' where id = '${c.fluxo}';`);
    expect(lastLine(sql(`select status from public.flows where id = '${c.fluxo}'`))).toBe("active");
  });
});

describe("4 · a demonstração: o que acontece quando um fluxo usado é reescrito", () => {
  it("num fluxo SEM a proteção (Automações), reescrever com os MESMOS ids anula o node_id do histórico", () => {
    const f = id("fd", 1);
    const n1 = id("d1", 1);
    const n2 = id("d2", 1);
    const contato = id("cd", 1);
    const exec = id("ed", 1);
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number) values ('${contato}', '${ORG_A}', 'Demo', '+5511988880507');
      insert into public.flows (id, organization_id, name, status) values ('${f}', '${ORG_A}', 'Demo', 'draft');
      insert into public.flow_nodes (id, organization_id, flow_id, type, config) values
        ('${n1}', '${ORG_A}', '${f}', 'TRIGGER', '{}'), ('${n2}', '${ORG_A}', '${f}', 'MESSAGE', '{"body":"x"}');
      insert into public.flow_executions (id, organization_id, flow_id, contact_id, current_node_id, status)
        values ('${exec}', '${ORG_A}', '${f}', '${contato}', '${n2}', 'completed');
      insert into public.flow_execution_events (organization_id, execution_id, node_id, event_type)
        values ('${ORG_A}', '${exec}', '${n1}', 'entered'), ('${ORG_A}', '${exec}', '${n2}', 'completed');
    `);
    como(
      MGR_A,
      `select public.fn_flow_replace_graph('${f}'::uuid, '${ORG_A}'::uuid,
         '[{"id":"${n1}","type":"TRIGGER","config":{}},{"id":"${n2}","type":"MESSAGE","config":{"body":"x"}}]'::jsonb, '[]'::jsonb);`,
    );
    // Os nós voltaram com os MESMOS ids — e o histórico perdeu a ligação mesmo assim.
    expect(num(sql(`select count(*) from public.flow_nodes where id in ('${n1}','${n2}')`))).toBe(2);
    expect(num(sql(`select count(*) from public.flow_execution_events where execution_id = '${exec}' and node_id is null`))).toBe(2);
    expect(lastLine(sql(`select coalesce(current_node_id::text,'nulo') from public.flow_executions where id = '${exec}'`))).toBe(
      "nulo",
    );
  });
});

describe("5 · o disparo que já tocou alguém não se apaga", () => {
  it("concluído com sent_count = 0, destinatário falho e execução: recusado (gestor e service_role)", () => {
    const c = caso(ORG_A, "completed");
    const dest = id("d0", 1);
    sql(`insert into public.broadcast_recipients (id, organization_id, broadcast_id, contact_id, status)
           values ('${dest}', '${ORG_A}', '${c.disparo}', '${c.contato}', 'failed');`);
    execucao(ORG_A, c, "status = 'failed'");
    expect(erroDe(() => como(MGR_A, `delete from public.broadcasts where id = '${c.disparo}';`))).toContain(
      "disparo_com_historico",
    );
    expect(erroDe(() => comoServiceRole(`delete from public.broadcasts where id = '${c.disparo}';`))).toContain(
      "disparo_com_historico",
    );
    expect(num(sql(`select count(*) from public.flow_nodes where flow_id = '${c.fluxo}'`))).toBe(2);
  });

  it("só com destinatário processado (sem execução) também é recusado", () => {
    const c = caso(ORG_A, "completed");
    sql(`insert into public.broadcast_recipients (organization_id, broadcast_id, contact_id, status)
           values ('${ORG_A}', '${c.disparo}', '${c.contato}', 'skipped');`);
    expect(erroDe(() => como(MGR_A, `delete from public.broadcasts where id = '${c.disparo}';`))).toContain(
      "disparo_com_historico",
    );
  });

  it("rascunho sem nada: apagado, e a cascata leva fluxo, nós e arestas", () => {
    const c = caso(ORG_A, "draft");
    como(MGR_A, `delete from public.broadcasts where id = '${c.disparo}';`);
    expect(
      lastLine(
        sql(`select (select count(*) from public.flows where id = '${c.fluxo}') || ':' ||
                    (select count(*) from public.flow_nodes where flow_id = '${c.fluxo}') || ':' ||
                    (select count(*) from public.flow_edges where flow_id = '${c.fluxo}');`),
      ),
    ).toBe("0:0:0");
  });

  it("agendado que ainda não começou (só destinatário pending): apagável", () => {
    const c = caso(ORG_A, "scheduled");
    sql(`insert into public.broadcast_recipients (organization_id, broadcast_id, contact_id, status)
           values ('${ORG_A}', '${c.disparo}', '${c.contato}', 'pending');`);
    como(MGR_A, `delete from public.broadcasts where id = '${c.disparo}';`);
    expect(num(sql(`select count(*) from public.broadcasts where id = '${c.disparo}'`))).toBe(0);
  });
});

describe("6 · apagar a ORGANIZAÇÃO continua apagando tudo", () => {
  it("org com disparo histórico, execuções, eventos e destinatários: a cascata passa", () => {
    const c = caso(ORG_C, "completed");
    sql(`insert into public.broadcast_recipients (organization_id, broadcast_id, contact_id, status)
           values ('${ORG_C}', '${c.disparo}', '${c.contato}', 'sent');`);
    execucao(ORG_C, c, "status = 'completed'");
    // Controle: a proteção está ativa nesta org antes da exclusão.
    expect(erroDe(() => sql(`delete from public.flow_nodes where flow_id = '${c.fluxo}';`))).toContain("flow_protegido");

    sql(`delete from public.organizations where id = '${ORG_C}';`);
    expect(
      lastLine(
        sql(`select (select count(*) from public.broadcasts where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.flows where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.flow_nodes where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.flow_edges where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.flow_executions where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.flow_execution_events where organization_id = '${ORG_C}') || ':' ||
                    (select count(*) from public.broadcast_recipients where organization_id = '${ORG_C}');`),
      ),
    ).toBe("0:0:0:0:0:0:0");
  });
});

describe("7 · isolamento entre organizações", () => {
  it("o estado de um fluxo de A não é revelado ao gestor de B; ao de A, sim", () => {
    const c = caso(ORG_A, "completed");
    expect(lastLine(como(MGR_B, `select coalesce(public.fn_flow_estado_de_edicao('${c.fluxo}')::text, 'nulo');`))).toBe(
      "nulo",
    );
    expect(JSON.parse(lastLine(como(MGR_A, `select public.fn_flow_estado_de_edicao('${c.fluxo}')::text;`)))).toMatchObject({
      estado: "historico",
    });
  });

  it("o gestor de B não duplica um disparo de A, nem passando a organização de A", () => {
    const c = caso(ORG_A, "completed");
    expect(
      erroDe(() => como(MGR_B, `select public.fn_broadcast_duplicar('${c.disparo}'::uuid, '${ORG_B}'::uuid);`)),
    ).toContain("broadcast_not_found_in_organization");
    // Com a organização de A: B não enxerga a origem (RLS de leitura).
    expect(
      erroDe(() => como(MGR_B, `select public.fn_broadcast_duplicar('${c.disparo}'::uuid, '${ORG_A}'::uuid);`)),
    ).toContain("broadcast_not_found_in_organization");
    expect(num(sql(`select count(*) from public.broadcasts where organization_id = '${ORG_B}'`))).toBe(0);
  });
});

describe("8 · duplicar o disparo", () => {
  it("copia nós, config, posições e arestas com ids novos — e nada da execução", () => {
    const c = caso(ORG_A, "completed");
    const exec = execucao(ORG_A, c, "status = 'waiting', waiting_for = 'button_reply'");
    sql(`insert into public.broadcast_recipients (organization_id, broadcast_id, contact_id, status)
           values ('${ORG_A}', '${c.disparo}', '${c.contato}', 'sent');`);
    // Imagem na pasta do fluxo de origem e um start_flow apontando para ele mesmo.
    sql(`
      alter table public.flow_nodes disable trigger trg_flow_nodes_protegido;
      update public.flow_nodes set config = jsonb_build_object(
        'blocks', jsonb_build_array(jsonb_build_object('id','b1','tipo','imagem',
          'media_storage_path', '${ORG_A}/flows/${c.fluxo}/foto.jpg')),
        'acao', jsonb_build_object('action_type','stop_flow','config', jsonb_build_object('flow_id','${c.fluxo}')))
       where id = '${c.noMensagem}';
      alter table public.flow_nodes enable trigger trg_flow_nodes_protegido;
    `);

    const r = JSON.parse(
      lastLine(como(MGR_A, `select public.fn_broadcast_duplicar('${c.disparo}'::uuid, '${ORG_A}'::uuid)::text;`)),
    ) as { broadcast_id: string; flow_id: string; flow_id_origem: string };
    expect(r.flow_id_origem).toBe(c.fluxo);
    expect(r.flow_id).not.toBe(c.fluxo);

    const novo = lastLine(
      sql(`select b.status || '|' || b.name || '|' || b.total_recipients || '|' || b.sent_count || '|' ||
                  f.status || '|' || f.trigger_type || '|' || f.version || '|' ||
                  coalesce(b.created_by_user_id::text, 'sem-autor')
             from public.broadcasts b join public.flows f on f.broadcast_id = b.id
            where b.id = '${r.broadcast_id}';`),
    ).split("|");
    expect(novo).toEqual(["draft", `Disparo ${novo[1]!.slice("Disparo ".length)}`, "0", "0", "draft", "broadcast", "1", MGR_A]);
    expect(novo[1]).toMatch(/^Disparo \d+ \(cópia\)$/);

    // Mesma estrutura, ids diferentes.
    expect(num(sql(`select count(*) from public.flow_nodes where flow_id = '${r.flow_id}'`))).toBe(2);
    expect(num(sql(`select count(*) from public.flow_edges where flow_id = '${r.flow_id}'`))).toBe(1);
    expect(
      num(sql(`select count(*) from public.flow_nodes where flow_id = '${r.flow_id}' and id in ('${c.noGatilho}','${c.noMensagem}')`)),
    ).toBe(0);
    // As arestas apontam para os nós NOVOS.
    expect(
      num(
        sql(`select count(*) from public.flow_edges e
               join public.flow_nodes s on s.id = e.source_node_id and s.flow_id = '${r.flow_id}'
               join public.flow_nodes t on t.id = e.target_node_id and t.flow_id = '${r.flow_id}'
              where e.flow_id = '${r.flow_id}';`),
      ),
    ).toBe(1);
    // Posições e tipos preservados.
    expect(
      lastLine(sql(`select string_agg(type || '@' || position_x::int || ',' || position_y::int, ' ' order by type)
                      from public.flow_nodes where flow_id = '${r.flow_id}'`)),
    ).toBe("MESSAGE@300,20 TRIGGER@10,20");
    // O id do fluxo dentro da config virou o novo (pasta da imagem e stop_flow).
    const cfg = lastLine(sql(`select config::text from public.flow_nodes where flow_id = '${r.flow_id}' and type = 'MESSAGE'`));
    expect(cfg).toContain(`${ORG_A}/flows/${r.flow_id}/foto.jpg`);
    expect(cfg).toContain(`"flow_id": "${r.flow_id}"`);
    expect(cfg).not.toContain(c.fluxo);

    // Nada de execução, evento ou destinatário.
    expect(
      lastLine(
        sql(`select (select count(*) from public.flow_executions where flow_id = '${r.flow_id}') || ':' ||
                    (select count(*) from public.flow_execution_events ev join public.flow_executions e on e.id = ev.execution_id
                      where e.flow_id = '${r.flow_id}') || ':' ||
                    (select count(*) from public.broadcast_recipients where broadcast_id = '${r.broadcast_id}');`),
      ),
    ).toBe("0:0:0");
    // A origem continua intacta.
    expect(lastLine(sql(`select status from public.flow_executions where id = '${exec}'`))).toBe("waiting");

    // O clone é editável na hora.
    expect(JSON.parse(lastLine(sql(`select public.fn_flow_estado_de_edicao_interno('${r.flow_id}')::text;`))).estado).toBe(
      "editavel",
    );
    const novoNo = lastLine(sql(`select id from public.flow_nodes where flow_id = '${r.flow_id}' and type = 'MESSAGE'`));
    como(MGR_A, `update public.flow_nodes set config = '{"body":"editado na cópia"}' where id = '${novoNo}';`);
    expect(lastLine(sql(`select config->>'body' from public.flow_nodes where id = '${novoNo}'`))).toBe("editado na cópia");
  });

  it("disparo guiado (sem fluxo) também duplica, sem fluxo", () => {
    const d = id("bb", 1);
    sql(`insert into public.broadcasts (id, organization_id, name, status, message)
           values ('${d}', '${ORG_A}', 'Guiado', 'completed', '{"body":"oi","window_mode":"inside_24h"}');`);
    const r = JSON.parse(lastLine(como(MGR_A, `select public.fn_broadcast_duplicar('${d}'::uuid, '${ORG_A}'::uuid)::text;`)));
    expect(r.flow_id).toBeNull();
    expect(lastLine(sql(`select status || ':' || (message->>'body') from public.broadcasts where id = '${r.broadcast_id}'`))).toBe(
      "draft:oi",
    );
  });
});

describe("9 · as funções internas não ficam expostas", () => {
  it.each([
    ["fn_flow_estado_de_edicao_interno(uuid)", "authenticated", false],
    ["fn_flow_estado_de_edicao_interno(uuid)", "anon", false],
    ["fn_flow_exigir_editavel(uuid)", "authenticated", false],
    ["fn_flow_exigir_editavel(uuid)", "service_role", false],
    ["fn_trg_flow_grafo_protegido()", "authenticated", false],
    ["fn_trg_flow_definicao_protegida()", "authenticated", false],
    ["fn_trg_broadcast_historico_protegido()", "authenticated", false],
    ["fn_flow_estado_de_edicao(uuid)", "anon", false],
    ["fn_flow_estado_de_edicao(uuid)", "authenticated", true],
    ["fn_broadcast_duplicar(uuid,uuid)", "anon", false],
    ["fn_broadcast_duplicar(uuid,uuid)", "authenticated", true],
  ] as const)("%s para %s: %s", (fn, papel, pode) => {
    expect(lastLine(sql(`select has_function_privilege('${papel}', 'public.${fn}', 'execute');`))).toBe(pode ? "t" : "f");
  });
});
