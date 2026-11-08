import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * Migration 9253 — as policies de `organizations` valem só para `authenticated`.
 *
 * ## O defeito que isto vigia
 *
 * `orgs_select` e `orgs_write_platform_admin` nasceram sem `TO` — valiam para
 * `public`, e `public` inclui `anon`. As duas chamam `fn_user_org_ids()` /
 * `fn_is_platform_admin()`, cujo EXECUTE a 0108 revogou de `anon`. Então toda
 * leitura anônima da tabela tropeçava no helper e o Postgres registrava
 * `permission denied for function fn_user_org_ids`. Quem lê assim é o ping do
 * `/api/v1/health` (`GET /rest/v1/organizations` com a anon key): na produção,
 * em 08/11/2026, foi um erro no log do banco por verificação de saúde.
 *
 * ## A régua, nos dois sentidos
 *
 *   - anon lê a tabela SEM erro e enxerga ZERO linhas — o conserto não pode
 *     virar concessão: nem leitura nem escrita anônima passam;
 *   - o isolamento entre organizações de `authenticated` segue idêntico (A vê
 *     só A, B vê só B, quem não é membro não vê nada) e o platform admin segue
 *     vendo todas — `alter policy ... to` não toca `using`/`with check`.
 *
 * Prova pelo controle: sem o bloco da 9253 no baseline, o primeiro caso falha
 * com `permission denied for function fn_user_org_ids`.
 */

const ORG_A = "9253aaaa-0000-4000-8000-000000000001";
const ORG_B = "9253bbbb-0000-4000-8000-000000000001";
const USER_A = "9253aaaa-1111-4000-8000-000000000001";
const USER_B = "9253bbbb-1111-4000-8000-000000000001";
const SEM_ORG = "9253cccc-1111-4000-8000-000000000001";
const ADMIN = "9253dddd-1111-4000-8000-000000000001";

/** Roda como `anon` com JWT vazio — o shape do PostgREST com a anon key. */
function comoAnon(script: string): string {
  return sql(`
    set role anon;
    select set_config('request.jwt.claims', '{}', false);
    ${script}
  `);
}

/** stderr do psql quando o script falha; "" quando passa. */
function erroComoAnon(script: string): string {
  try {
    comoAnon(script);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

beforeAll(() => {
  // Sem PII real: e-mails sintéticos (LGPD).
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'org9253-a@invariant.test'),
      ('${USER_B}', 'org9253-b@invariant.test'),
      ('${SEM_ORG}', 'org9253-sem@invariant.test'),
      ('${ADMIN}', 'org9253-admin@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'org9253-a', 'Org 9253 A', 'Org 9253 A'),
      ('${ORG_B}', 'org9253-b', 'Org 9253 B', 'Org 9253 B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'admin', now()),
      ('${USER_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason, mfa_required)
      values ('${ADMIN}', '${ADMIN}', 'invariante 9253', false)
      on conflict do nothing;
  `);
});

describe("9253 — anon lê organizations sem erro de permissão e sem ver nada", () => {
  it("o SELECT anônimo (o ping do health) não avalia helper e não dá permission denied", () => {
    const erro = erroComoAnon(`select id from public.organizations limit 1;`);
    expect(erro).not.toMatch(/permission denied/);
    expect(erro).toBe("");
  });

  it("anon enxerga zero linhas, com organizações existindo na tabela", () => {
    const total = Number(lastLine(sql(`select count(*) from public.organizations;`)));
    expect(total).toBeGreaterThanOrEqual(2);
    expect(Number(lastLine(comoAnon(`select count(*) from public.organizations;`)))).toBe(0);
  });

  it("anon não escreve: insert, update e delete continuam barrados", () => {
    expect(
      erroComoAnon(
        `insert into public.organizations (slug, legal_name, display_name)
           values ('org9253-anon', 'Anon', 'Anon');`,
      ),
    ).toMatch(/row-level security|permission denied/);
    // update/delete sem policy aplicável não acham linha: zero afetadas.
    expect(
      lastLine(
        comoAnon(
          `with u as (update public.organizations set display_name = 'x' where id = '${ORG_A}' returning 1)
       select count(*) from u;`,
        ),
      ),
    ).toBe("0");
    expect(
      lastLine(
        comoAnon(
          `with d as (delete from public.organizations where id = '${ORG_A}' returning 1)
       select count(*) from d;`,
        ),
      ),
    ).toBe("0");
    expect(
      lastLine(sql(`select display_name from public.organizations where id = '${ORG_A}';`)),
    ).toBe("Org 9253 A");
  });

  it("as duas policies valem só para authenticated", () => {
    const out = sql(`
      select policyname || '=' || array_to_string(roles, ',') from pg_policies
       where schemaname = 'public' and tablename = 'organizations'
         and policyname in ('orgs_select', 'orgs_write_platform_admin')
       order by policyname;
    `);
    expect(out.split("\n")).toEqual([
      "orgs_select=authenticated",
      "orgs_write_platform_admin=authenticated",
    ]);
  });
});

describe("9253 — o isolamento entre organizações de authenticated não muda", () => {
  const conta = (org: string) => `select count(*) from public.organizations where id = '${org}';`;

  it("membro de A vê A e não vê B; membro de B vê B e não vê A", () => {
    expect(countAs(USER_A, conta(ORG_A))).toBe(1);
    expect(countAs(USER_A, conta(ORG_B))).toBe(0);
    expect(countAs(USER_B, conta(ORG_B))).toBe(1);
    expect(countAs(USER_B, conta(ORG_A))).toBe(0);
  });

  it("usuário logado sem vínculo não vê nenhuma das duas", () => {
    expect(
      countAs(
        SEM_ORG,
        `select count(*) from public.organizations where id in ('${ORG_A}', '${ORG_B}');`,
      ),
    ).toBe(0);
  });

  it("o platform admin segue vendo as duas", () => {
    expect(
      countAs(
        ADMIN,
        `select count(*) from public.organizations where id in ('${ORG_A}', '${ORG_B}');`,
      ),
    ).toBe(2);
  });
});
