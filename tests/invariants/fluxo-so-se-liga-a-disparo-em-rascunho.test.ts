import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * 0508 · UM FLUXO SÓ SE LIGA A UM DISPARO EM RASCUNHO.
 *
 * A 0507 protegia o fluxo que JÁ era de um disparo; o vínculo novo passava. Pela
 * REST direta, um gestor criava um fluxo apontando para um disparo guiado em
 * andamento (o worker passaria quem ainda não recebeu por ele) ou concluído (o
 * disparo passaria a se apresentar como "modo fluxo"). Aqui, pelo banco que o
 * self-host aplica: inserir e ligar só com o disparo em `draft`, da mesma
 * organização — como gestor (REST) e como `service_role`; Automações intactas.
 *
 * Sabotagem medida: sem o gatilho `trg_flows_vinculo_ao_disparo`, os casos de
 * recusa ficam vermelhos (o vínculo passa) e os de aceite seguem verdes.
 */

const P = "0508";
const id = (g: string, n: number) => `${P}${g}aa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id("0a", 1);
const ORG_B = id("0b", 1);
const MGR_A = id("1a", 1);

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

let seq = 0;
/** Disparo GUIADO (sem fluxo) no status pedido. */
function disparo(org: string, status: string): string {
  seq += 1;
  const d = id("b0", seq);
  sql(`insert into public.broadcasts (id, organization_id, name, status) values ('${d}', '${org}', 'D${seq}', '${status}');`);
  return d;
}
const novoFluxo = () => id("f0", ++seq);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MGR_A}', 'mgr-a-0508@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0508-a', 'Org A 0508', 'Org A 0508'),
      ('${ORG_B}', 'inv-0508-b', 'Org B 0508', 'Org B 0508')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MGR_A}', '${ORG_A}', 'manager', now()) on conflict do nothing;
  `);
});

const NAO_RASCUNHO = ["scheduled", "paused", "running", "completed", "cancelled", "failed"] as const;

describe("INSERT de fluxo com broadcast_id", () => {
  it("disparo em rascunho da mesma organização: aceito (gestor pela REST)", () => {
    const d = disparo(ORG_A, "draft");
    const f = novoFluxo();
    como(MGR_A, `insert into public.flows (id, organization_id, name, trigger_type, broadcast_id)
                  values ('${f}', '${ORG_A}', 'ok', 'broadcast', '${d}');`);
    expect(lastLine(sql(`select broadcast_id from public.flows where id = '${f}'`))).toBe(d);
  });

  it.each(NAO_RASCUNHO)("disparo %s: recusado (gestor pela REST)", (status) => {
    const d = disparo(ORG_A, status);
    const f = novoFluxo();
    expect(
      erroDe(() =>
        como(MGR_A, `insert into public.flows (id, organization_id, name, trigger_type, broadcast_id)
                      values ('${f}', '${ORG_A}', 'x', 'broadcast', '${d}');`),
      ),
    ).toContain(`flow_vinculo_invalido:${status}`);
    expect(lastLine(sql(`select count(*) from public.flows where id = '${f}'`))).toBe("0");
  });

  it.each(NAO_RASCUNHO)("disparo %s: recusado também para service_role", (status) => {
    const d = disparo(ORG_A, status);
    expect(
      erroDe(() =>
        comoServiceRole(`insert into public.flows (organization_id, name, trigger_type, broadcast_id)
                          values ('${ORG_A}', 'x', 'broadcast', '${d}');`),
      ),
    ).toContain(`flow_vinculo_invalido:${status}`);
  });

  it("disparo de OUTRA organização (mesmo em rascunho): recusado — gestor e service_role", () => {
    const dB = disparo(ORG_B, "draft");
    expect(
      erroDe(() =>
        como(MGR_A, `insert into public.flows (organization_id, name, trigger_type, broadcast_id)
                      values ('${ORG_A}', 'x', 'broadcast', '${dB}');`),
      ),
    ).toContain("flow_vinculo_invalido:disparo_fora_da_organizacao");
    expect(
      erroDe(() =>
        comoServiceRole(`insert into public.flows (organization_id, name, trigger_type, broadcast_id)
                          values ('${ORG_A}', 'x', 'broadcast', '${dB}');`),
      ),
    ).toContain("flow_vinculo_invalido:disparo_fora_da_organizacao");
    expect(lastLine(sql(`select count(*) from public.flows where broadcast_id = '${dB}'`))).toBe("0");
  });
});

describe("UPDATE de broadcast_id", () => {
  /** Fluxo de Automações (sem disparo), rascunho. */
  function automacao(): string {
    const f = novoFluxo();
    sql(`insert into public.flows (id, organization_id, name, status) values ('${f}', '${ORG_A}', 'auto', 'draft');`);
    return f;
  }
  const ligar = (f: string, d: string) =>
    `update public.flows set broadcast_id = '${d}', trigger_type = 'broadcast' where id = '${f}';`;

  it("NULL → disparo em rascunho: aceito", () => {
    const f = automacao();
    const d = disparo(ORG_A, "draft");
    como(MGR_A, ligar(f, d));
    expect(lastLine(sql(`select broadcast_id from public.flows where id = '${f}'`))).toBe(d);
  });

  it.each(NAO_RASCUNHO)("NULL → disparo %s: recusado, e o fluxo segue sem disparo", (status) => {
    const f = automacao();
    const d = disparo(ORG_A, status);
    expect(erroDe(() => como(MGR_A, ligar(f, d)))).toContain(`flow_vinculo_invalido:${status}`);
    expect(lastLine(sql(`select coalesce(broadcast_id::text, 'nulo') from public.flows where id = '${f}'`))).toBe("nulo");
  });

  it("NULL → disparo de outra organização: recusado (também service_role)", () => {
    const f = automacao();
    const dB = disparo(ORG_B, "draft");
    expect(erroDe(() => como(MGR_A, ligar(f, dB)))).toContain("flow_vinculo_invalido:disparo_fora_da_organizacao");
    expect(erroDe(() => comoServiceRole(ligar(f, dB)))).toContain("flow_vinculo_invalido:disparo_fora_da_organizacao");
  });

  it("já ligado a um rascunho → OUTRO disparo não-rascunho: recusado; → outro rascunho: aceito", () => {
    const d1 = disparo(ORG_A, "draft");
    const f = novoFluxo();
    sql(`insert into public.flows (id, organization_id, name, trigger_type, broadcast_id) values ('${f}', '${ORG_A}', 'v', 'broadcast', '${d1}');`);
    const emCurso = disparo(ORG_A, "running");
    expect(erroDe(() => como(MGR_A, `update public.flows set broadcast_id = '${emCurso}' where id = '${f}';`))).toContain(
      "flow_vinculo_invalido:running",
    );
    expect(lastLine(sql(`select broadcast_id from public.flows where id = '${f}'`))).toBe(d1);
    const d2 = disparo(ORG_A, "draft");
    como(MGR_A, `update public.flows set broadcast_id = '${d2}' where id = '${f}';`);
    expect(lastLine(sql(`select broadcast_id from public.flows where id = '${f}'`))).toBe(d2);
  });
});

describe("o que NÃO muda", () => {
  it("Automações (broadcast_id NULL): criar, renomear e trocar gatilho seguem livres", () => {
    const f = novoFluxo();
    como(MGR_A, `insert into public.flows (id, organization_id, name, status) values ('${f}', '${ORG_A}', 'a', 'draft');`);
    como(MGR_A, `update public.flows set name = 'b', trigger_type = 'contact_created' where id = '${f}';`);
    expect(lastLine(sql(`select name || ':' || trigger_type from public.flows where id = '${f}'`))).toBe("b:contact_created");
  });

  it("vínculo que já existe não é reavaliado: o disparo segue o ciclo e o nome do fluxo continua editável", () => {
    const d = disparo(ORG_A, "draft");
    const f = novoFluxo();
    sql(`insert into public.flows (id, organization_id, name, trigger_type, broadcast_id) values ('${f}', '${ORG_A}', 'v', 'broadcast', '${d}');`);
    sql(`update public.broadcasts set status = 'completed' where id = '${d}';`);
    como(MGR_A, `update public.flows set name = 'renomeado' where id = '${f}';`);
    expect(lastLine(sql(`select name from public.flows where id = '${f}'`))).toBe("renomeado");
  });

  it("a função do gatilho não é executável por ninguém da API", () => {
    for (const papel of ["anon", "authenticated", "service_role"]) {
      expect(
        lastLine(sql(`select has_function_privilege('${papel}', 'public.fn_trg_flow_vinculo_ao_disparo()', 'execute');`)),
      ).toBe("f");
    }
  });
});
