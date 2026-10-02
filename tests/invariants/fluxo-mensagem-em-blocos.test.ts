import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * 0502 · O ESTADO DURÁVEL do nó de mensagem em blocos, no banco que o clone recebe.
 *
 *   - `node_cursor` guarda o próximo bloco dentro do nó e recusa valor negativo;
 *   - `listening_node_id` aponta para um nó DO banco e vira nulo quando o nó
 *     some (o clique tardio não aponta para lugar nenhum);
 *   - o índice parcial que o handler de resposta usa existe;
 *   - a execução antiga (sem os campos) continua válida.
 */

const ORG = "0502aaaa-0000-4000-8000-000000000001";
const CONTATO = "0502aaaa-2222-4000-8000-000000000001";
const FLUXO = "0502aaaa-4444-4000-8000-000000000001";
const NO_MSG = "0502aaaa-5555-4000-8000-000000000001";
const EXEC = "0502aaaa-6666-4000-8000-000000000001";

function seed(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-0502', 'Blocos 0502', 'Blocos 0502') on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Ana', '+5511900000502') on conflict do nothing;
    insert into public.flows (id, organization_id, name, trigger_type)
      values ('${FLUXO}', '${ORG}', 'Fluxo 0502', 'contact_tag_added') on conflict do nothing;
    insert into public.flow_nodes (id, organization_id, flow_id, type, config)
      values ('${NO_MSG}', '${ORG}', '${FLUXO}', 'MESSAGE',
              '{"blocks":[{"id":"a","tipo":"texto","texto":"Oi"},{"id":"d","tipo":"atraso","segundos":3}]}'::jsonb)
      on conflict do nothing;
  `);
}

describe("0502 · o estado durável do nó em blocos", () => {
  it("a execução guarda cursor e o nó cujos botões seguem clicáveis", () => {
    seed();
    sql(`insert into public.flow_executions (id, organization_id, flow_id, contact_id, status, waiting_for,
                                             waiting_node_id, current_node_id, next_execution_at, node_cursor,
                                             listening_node_id, listening_until)
           values ('${EXEC}', '${ORG}', '${FLUXO}', '${CONTATO}', 'waiting', 'delay',
                   '${NO_MSG}', '${NO_MSG}', now() + interval '3 seconds', 2,
                   '${NO_MSG}', now() + interval '72 hours');`);
    expect(sql(`select node_cursor || '|' || (listening_node_id = '${NO_MSG}')::text from public.flow_executions where id = '${EXEC}'`)).toBe(
      "2|true",
    );
  });

  it("cursor negativo é recusado", () => {
    expect(() => sql(`update public.flow_executions set node_cursor = -1 where id = '${EXEC}';`)).toThrow();
  });

  it("o índice do clique tardio existe", () => {
    expect(
      sql(`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'idx_flow_executions_listening'`),
    ).toBe("1");
  });

  it("apagar o nó ESCUTADO não apaga a execução — só a escuta", () => {
    sql(`update public.flow_executions set waiting_node_id = null, current_node_id = null where id = '${EXEC}';
         delete from public.flow_nodes where id = '${NO_MSG}';`);
    expect(sql(`select count(*) || '|' || count(listening_node_id) from public.flow_executions where id = '${EXEC}'`)).toBe("1|0");
  });

  it("execução sem os campos novos (as antigas) continua válida", () => {
    sql(`insert into public.flow_executions (organization_id, flow_id, contact_id, status)
           values ('${ORG}', '${FLUXO}', '${CONTATO}', 'completed');`);
    expect(
      sql(`select count(*) from public.flow_executions where flow_id = '${FLUXO}' and status = 'completed' and node_cursor is null and listening_node_id is null`),
    ).toBe("1");
  });
});
