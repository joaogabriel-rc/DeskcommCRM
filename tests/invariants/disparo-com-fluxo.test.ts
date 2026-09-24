import { describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

/**
 * 0394 · O DISPARO COM FLUXO, no banco que o CLONE recebe (`supabase/baseline.sql`).
 *
 * O que só o BANCO consegue garantir — valha a escrita da rota, do MCP ou de um
 * script:
 *
 *   - `flows.broadcast_id` é da MESMA organização (FK composta) e um disparo tem
 *     um fluxo só;
 *   - gatilho `broadcast` ⇔ `broadcast_id` (`flows_disparo_coerente`): fluxo de
 *     Automações não vira fluxo de disparo, e vice-versa;
 *   - a execução de disparo (`fn_flow_execution_do_disparo_coerente`): o
 *     destinatário é do disparo DONO do fluxo, do mesmo contato e organização,
 *     e a permissão é da mesma organização e contato; um destinatário, uma
 *     execução; execução de disparo sem permissão não existe;
 *   - `fn_broadcast_materializar` recusa número de outra organização;
 *   - a RLS: membro de B não vê disparo nem fluxo de A.
 */

const A = "0394aaaa-0000-4000-8000-000000000001";
const B = "0394bbbb-0000-4000-8000-000000000002";
const MEMBRO_B = "0394bbbb-1111-4000-8000-000000000002";
const CONTATO_A = "0394aaaa-2222-4000-8000-000000000001";
const CONTATO_A2 = "0394aaaa-2222-4000-8000-000000000002";
const DISPARO_A = "0394aaaa-3333-4000-8000-000000000001";
const DISPARO_A2 = "0394aaaa-3333-4000-8000-000000000002";
const DISPARO_B = "0394bbbb-3333-4000-8000-000000000001";
const FLUXO_A = "0394aaaa-4444-4000-8000-000000000001";
const FLUXO_A2 = "0394aaaa-4444-4000-8000-000000000002";
const DEST_A = "0394aaaa-5555-4000-8000-000000000001";
const DEST_A2 = "0394aaaa-5555-4000-8000-000000000002";
const SESSAO_B = "0394bbbb-6666-4000-8000-000000000001";

const permissao = (org: string, contato: string) =>
  `jsonb_build_object('organization_id','${org}','contact_id','${contato}','conversation_id',gen_random_uuid(),'service_revision',1,'demanda_id',null,'demanda_revision',null)`;

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("a escrita passou — a trava não existe neste banco");
}

function seed(): void {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_B}', 'membro-b-0394@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${A}', 'inv-0394-a', 'Disparo A', 'Disparo A'),
      ('${B}', 'inv-0394-b', 'Disparo B', 'Disparo B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_B}', '${B}', 'manager', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number) values
      ('${CONTATO_A}', '${A}', 'Ana', '+5511900000394'),
      ('${CONTATO_A2}', '${A}', 'Bia', '+5511900000395')
      on conflict do nothing;
    insert into public.broadcasts (id, organization_id, name) values
      ('${DISPARO_A}', '${A}', 'Disparo A'),
      ('${DISPARO_A2}', '${A}', 'Disparo A2'),
      ('${DISPARO_B}', '${B}', 'Disparo B')
      on conflict do nothing;
    insert into public.flows (id, organization_id, name, trigger_type, broadcast_id) values
      ('${FLUXO_A}', '${A}', 'Fluxo do disparo A', 'broadcast', '${DISPARO_A}'),
      ('${FLUXO_A2}', '${A}', 'Fluxo do disparo A2', 'broadcast', '${DISPARO_A2}')
      on conflict do nothing;
    insert into public.broadcast_recipients (id, organization_id, broadcast_id, contact_id, service_boundary) values
      ('${DEST_A}', '${A}', '${DISPARO_A}', '${CONTATO_A}', ${permissao(A, CONTATO_A)}),
      ('${DEST_A2}', '${A}', '${DISPARO_A2}', '${CONTATO_A}', ${permissao(A, CONTATO_A)})
      on conflict do nothing;
  `);
}

function execucao(o: { fluxo?: string; destinatario?: string; contato?: string; perm?: string }): string {
  return `insert into public.flow_executions (organization_id, flow_id, contact_id, broadcast_recipient_id, service_boundary)
          values ('${A}', '${o.fluxo ?? FLUXO_A}', '${o.contato ?? CONTATO_A}', '${o.destinatario ?? DEST_A}', ${o.perm ?? permissao(A, CONTATO_A)});`;
}

describe("0394 · o fluxo do disparo", () => {
  it("o fluxo do disparo nasce, e o gatilho `broadcast` está no vocabulário", () => {
    seed();
    expect(sql(`select trigger_type || ':' || broadcast_id from public.flows where id = '${FLUXO_A}'`)).toBe(
      `broadcast:${DISPARO_A}`,
    );
  });

  it("fluxo de OUTRA organização não aponta para o disparo desta (FK composta)", () => {
    // Disparo de A ainda SEM fluxo: assim só a FK composta pode recusar (o
    // índice "um fluxo por disparo" não entra na conta).
    sql(`insert into public.broadcasts (id, organization_id, name)
           values ('0394aaaa-3333-4000-8000-0000000000ee', '${A}', 'sem fluxo') on conflict do nothing;`);
    expect(
      erroDe(() =>
        sql(`insert into public.flows (organization_id, name, trigger_type, broadcast_id)
               values ('${B}', 'intruso', 'broadcast', '0394aaaa-3333-4000-8000-0000000000ee');`),
      ),
    ).toContain("flows_broadcast_org_fk");
  });

  it("um disparo tem UM fluxo", () => {
    expect(
      erroDe(() =>
        sql(`insert into public.flows (organization_id, name, trigger_type, broadcast_id)
               values ('${A}', 'segundo', 'broadcast', '${DISPARO_A}');`),
      ),
    ).toContain("uq_flows_broadcast");
  });

  it("gatilho `broadcast` sem dono, e dono com gatilho comum, são recusados", () => {
    expect(
      erroDe(() => sql(`insert into public.flows (organization_id, name, trigger_type) values ('${A}', 'x', 'broadcast');`)),
    ).toContain("flows_disparo_coerente");
    expect(
      erroDe(() =>
        sql(`insert into public.flows (organization_id, name, trigger_type, broadcast_id)
               values ('${B}', 'y', 'contact_tag_added', '${DISPARO_B}');`),
      ),
    ).toContain("flows_disparo_coerente");
  });

  it("apagar o disparo leva o fluxo dele junto", () => {
    sql(`insert into public.broadcasts (id, organization_id, name) values ('0394aaaa-3333-4000-8000-0000000000ff', '${A}', 'efêmero');
         insert into public.flows (id, organization_id, name, trigger_type, broadcast_id)
           values ('0394aaaa-4444-4000-8000-0000000000ff', '${A}', 'efêmero', 'broadcast', '0394aaaa-3333-4000-8000-0000000000ff');
         delete from public.broadcasts where id = '0394aaaa-3333-4000-8000-0000000000ff';`);
    expect(sql(`select count(*) from public.flows where id = '0394aaaa-4444-4000-8000-0000000000ff'`)).toBe("0");
  });
});

describe("0394 · a execução iniciada pelo disparo", () => {
  it("destinatário do disparo DONO do fluxo, mesmo contato e permissão coerente: entra", () => {
    sql(execucao({}));
    expect(
      sql(`select count(*) from public.flow_executions where broadcast_recipient_id = '${DEST_A}' and service_boundary is not null`),
    ).toBe("1");
  });

  it("um destinatário inicia NO MÁXIMO uma execução", () => {
    expect(erroDe(() => sql(execucao({})))).toMatch(/uq_flow_executions_recipient|idx_flow_executions_one_active_per_contact/);
  });

  it("destinatário de OUTRO disparo não inicia este fluxo", () => {
    expect(erroDe(() => sql(execucao({ destinatario: DEST_A2 })))).toContain("flow_execution_disparo_incoerente");
  });

  it("destinatário usado para OUTRO contato: recusado", () => {
    expect(erroDe(() => sql(execucao({ fluxo: FLUXO_A2, destinatario: DEST_A2, contato: CONTATO_A2 })))).toContain(
      "flow_execution_disparo_incoerente",
    );
  });

  it("permissão de OUTRA organização ou de outro contato: recusada", () => {
    expect(erroDe(() => sql(execucao({ fluxo: FLUXO_A2, destinatario: DEST_A2, perm: permissao(B, CONTATO_A) })))).toContain(
      "flow_execution_permissao_de_outro_escopo",
    );
    expect(
      erroDe(() => sql(execucao({ fluxo: FLUXO_A2, destinatario: DEST_A2, perm: permissao(A, CONTATO_A2) }))),
    ).toContain("flow_execution_permissao_de_outro_escopo");
  });

  it("execução de disparo SEM permissão não existe", () => {
    // O trigger (BEFORE INSERT) recusa antes de o CHECK rodar; as duas travas
    // dizem a mesma coisa, e qualquer uma basta.
    expect(erroDe(() => sql(execucao({ fluxo: FLUXO_A2, destinatario: DEST_A2, perm: "null" })))).toMatch(
      /flow_executions_disparo_tem_permissao|flow_execution_permissao_de_outro_escopo/,
    );
  });

  it("controle: execução COMUM (sem destinatário) segue como sempre", () => {
    sql(`insert into public.flows (id, organization_id, name, trigger_type)
           values ('0394aaaa-4444-4000-8000-0000000000aa', '${A}', 'comum', 'contact_created') on conflict do nothing;
         insert into public.flow_executions (organization_id, flow_id, contact_id)
           values ('${A}', '0394aaaa-4444-4000-8000-0000000000aa', '${CONTATO_A2}');`);
    expect(sql(`select count(*) from public.flow_executions where flow_id = '0394aaaa-4444-4000-8000-0000000000aa'`)).toBe("1");
  });
});

describe("0394 · materialização e RLS", () => {
  it("materializar com número de OUTRA organização é recusado dentro do definer", () => {
    sql(`insert into public.channel_sessions (id, organization_id, provider, meta_phone_number_id, webhook_secret_encrypted)
           values ('${SESSAO_B}', '${B}', 'meta_cloud', 'pn-0394-b', '\\x00'::bytea) on conflict do nothing;`);
    expect(
      erroDe(() =>
        sql(`select public.fn_broadcast_materializar('${DISPARO_A}', '${A}', array['${CONTATO_A2}']::uuid[], '${SESSAO_B}');`),
      ),
    ).toContain("broadcast_session_not_in_organization");
    expect(sql(`select count(*) from public.broadcast_recipients where contact_id = '${CONTATO_A2}' and broadcast_id = '${DISPARO_A}'`)).toBe("0");
  });

  it("a assinatura antiga (3 argumentos) não existe mais — o PostgREST não resolve na sobrecarga velha", () => {
    expect(sql(`select count(*) from pg_proc where proname = 'fn_broadcast_materializar'`)).toBe("1");
    expect(
      sql(`select has_function_privilege('authenticated', 'public.fn_broadcast_materializar(uuid,uuid,uuid[],uuid)', 'execute')`),
    ).toBe("f");
  });

  it("membro de B não vê disparo, fluxo nem execução de A", () => {
    expect(countAs(MEMBRO_B, `select count(*) from public.broadcasts where organization_id = '${A}';`)).toBe(0);
    expect(countAs(MEMBRO_B, `select count(*) from public.flows where organization_id = '${A}';`)).toBe(0);
    expect(countAs(MEMBRO_B, `select count(*) from public.flow_executions where organization_id = '${A}';`)).toBe(0);
  });
});
