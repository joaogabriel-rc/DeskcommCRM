import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * 0393 · O FLUXO NASCE SEM GATILHO, E SÓ LIGA COM ELE — medido no banco que o
 * CLONE recebe (`supabase/baseline.sql`, via `scripts/test-db.sh`).
 *
 * "Novo fluxo" abre direto no construtor e o gatilho é escolhido no nó
 * "Quando…". Entre o clique e a escolha, o fluxo é um rascunho com
 * `trigger_type` NULO — e antes da 0393 a coluna era `not null default
 * 'contact_tag_added'`, então o rascunho nascia dizendo que escuta "tag
 * atribuída" sem tag nenhuma.
 *
 * O que está sob prova, nos dois sentidos:
 *   - o rascunho sem gatilho EXISTE, e o default não inventa um;
 *   - o vocabulário continua fechado (gatilho inventado é recusado);
 *   - ATIVO sem gatilho é recusado pelo banco (`flows_ativo_exige_gatilho`),
 *     não só pela rota — MCP, script e integração passam pela mesma trava.
 */

// Namespace pela migration: arquivos de invariante rodam em paralelo no mesmo
// container, e UUID repetido vira membro de outra organização.
const ORG = "0393aaaa-0000-4000-8000-000000000001";

// Com `returning`, o psql imprime o valor E a tag do comando (`INSERT 0 1`):
// os casos abaixo leem só a primeira linha.
function seed(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-0393', 'Fluxo Rascunho 0393', 'Inv 0393')
      on conflict do nothing;
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("a escrita passou — a trava não existe neste banco");
}

describe("0393 · rascunho sem gatilho", () => {
  it("o fluxo criado sem gatilho nasce com trigger_type NULO — o default não inventa um", () => {
    seed();
    expect(
      sql(`insert into public.flows (organization_id, name) values ('${ORG}', 'rascunho-0393')
             returning coalesce(trigger_type, '<nulo>') || ':' || status;`).split("\n")[0],
    ).toBe("<nulo>:draft");
  });

  it("gatilho inventado continua recusado pelo CHECK do vocabulário", () => {
    expect(
      erroDe(() =>
        sql(`insert into public.flows (organization_id, name, trigger_type)
               values ('${ORG}', 'invalido-0393', 'gatilho_que_nao_existe');`),
      ),
    ).toContain("flows_trigger_type_check");
  });

  it("ATIVAR sem gatilho é recusado pelo banco", () => {
    expect(
      erroDe(() =>
        sql(`update public.flows set status = 'active'
               where organization_id = '${ORG}' and name = 'rascunho-0393';`),
      ),
    ).toContain("flows_ativo_exige_gatilho");
  });

  it("controle: com o gatilho escolhido, o mesmo fluxo liga", () => {
    expect(
      sql(`update public.flows set trigger_type = 'contact_tag_added', status = 'active'
             where organization_id = '${ORG}' and name = 'rascunho-0393'
           returning status;`).split("\n")[0],
    ).toBe("active");
  });
});
