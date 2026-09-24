import { describe, expect, it } from "vitest";

import { columnExists, countAs, indexExists, sql } from "./gov-helpers";

/**
 * O que a migration 0395 promete, cobrado no banco que o CLONE recebe (baseline).
 *
 * `meta_templates.provider_template_id` guarda o id que a Meta devolveu ao criar
 * o modelo pelo CRM. Ele é anulável (modelo antigo ou só sincronizado), não é a
 * identidade local (`id` uuid) e é único só dentro de (organização, conta) —
 * nunca na instalação: a mesma conta pode estar em duas organizações, e cada
 * idioma de um modelo tem id próprio na Meta.
 */

// Namespace pela MIGRATION, como os demais invariantes (arquivos rodam em
// paralelo contra o mesmo container).
const ORG_A = "0395aaaa-0000-4000-8000-000000000001";
const ORG_B = "0395bbbb-0000-4000-8000-000000000002";
const MEMBRO_A = "0395aaaa-1111-4000-8000-000000000001";
const MEMBRO_B = "0395bbbb-1111-4000-8000-000000000002";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${MEMBRO_A}', 'ptid-a@invariant.test'),
      ('${MEMBRO_B}', 'ptid-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ptid-inv-a', 'Provider Template Id A', 'PTID A'),
      ('${ORG_B}', 'ptid-inv-b', 'Provider Template Id B', 'PTID B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_A}', '${ORG_A}', 'admin', now()),
      ('${MEMBRO_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
  `);
}

const COLS = "(organization_id, waba_id, name, language, status, components, contract_hash, provider_template_id)";
function linha(org: string, waba: string, name: string, language: string, ptid: string | null): string {
  const id = ptid === null ? "null" : `'${ptid}'`;
  return `('${org}', '${waba}', '${name}', '${language}', 'PENDING', '[]'::jsonb, 'h-${name}-${language}', ${id})`;
}
const inserir = (valores: string) => sql(`insert into public.meta_templates ${COLS} values ${valores};`);

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("a escrita passou — a trava não existe neste banco");
}

describe("0395 · provider_template_id no espelho de modelos", () => {
  it("a coluna existe, é texto e anulável; o índice é PARCIAL e por (organização, conta)", () => {
    seed();
    expect(columnExists("meta_templates", "provider_template_id")).toBe(true);
    expect(
      sql(`select data_type || ':' || is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'meta_templates' and column_name = 'provider_template_id'`),
    ).toBe("text:YES");
    expect(indexExists("uq_meta_templates_provider_template_id")).toBe(true);
    expect(
      sql(`select indexdef from pg_indexes where indexname = 'uq_meta_templates_provider_template_id'`),
    ).toMatch(/UNIQUE INDEX .*\(organization_id, waba_id, provider_template_id\) WHERE \(provider_template_id IS NOT NULL\)/);
  });

  it("modelo antigo (sem id da Meta) convive: vários nulos na mesma conta", () => {
    inserir(`${linha(ORG_A, "111", "antigo_1", "pt_BR", null)}, ${linha(ORG_A, "111", "antigo_2", "pt_BR", null)}`);
    expect(
      sql(`select count(*) from public.meta_templates
            where organization_id = '${ORG_A}' and provider_template_id is null`),
    ).toBe("2");
  });

  it("o mesmo id da Meta NÃO se repete na mesma organização e conta", () => {
    inserir(linha(ORG_A, "111", "novo", "pt_BR", "9001"));
    expect(erroDe(() => inserir(linha(ORG_A, "111", "outro", "pt_BR", "9001")))).toContain(
      "uq_meta_templates_provider_template_id",
    );
  });

  it("o mesmo id convive em OUTRA conta e em OUTRA organização — a unicidade não é global", () => {
    inserir(linha(ORG_A, "222", "novo", "pt_BR", "9001"));
    inserir(linha(ORG_B, "111", "novo", "pt_BR", "9001"));
    expect(sql(`select count(*) from public.meta_templates where provider_template_id = '9001'`)).toBe("3");
  });

  it("cada idioma do mesmo nome tem o seu id", () => {
    inserir(linha(ORG_A, "111", "novo", "en_US", "9002"));
    expect(
      sql(`select string_agg(language || '=' || provider_template_id, ',' order by language)
            from public.meta_templates where organization_id = '${ORG_A}' and waba_id = '111' and name = 'novo'`),
    ).toBe("en_US=9002,pt_BR=9001");
  });

  it("vazio não é id", () => {
    expect(erroDe(() => inserir(linha(ORG_A, "111", "vazio", "pt_BR", "  ")))).toContain(
      "meta_templates_provider_template_id_nao_vazio",
    );
  });

  it("isolamento: o membro da B não vê o modelo (nem o id da Meta) da A", () => {
    expect(
      countAs(MEMBRO_B, `select count(*) from public.meta_templates where organization_id = '${ORG_A}';`),
    ).toBe(0);
    expect(
      countAs(MEMBRO_B, `select count(*) from public.meta_templates where provider_template_id is not null;`),
    ).toBe(1); // só a linha da própria B
    expect(
      countAs(MEMBRO_A, `select count(*) from public.meta_templates where provider_template_id = '9001';`),
    ).toBe(2); // as duas contas da A
  });

  it("o id da Meta não é identidade local: o id uuid continua sendo a chave primária", () => {
    expect(
      sql(`select a.attname from pg_index i
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
            where i.indrelid = 'public.meta_templates'::regclass and i.indisprimary`),
    ).toBe("id");
  });
});
