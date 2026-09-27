import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * ECOS DO APP EM ESPERA (0436) — medidos NO BANCO, com a função e os triggers reais.
 *
 *   - a quarentena é só do servidor (nem o admin da própria organização lê pela
 *     anon/authenticated), com RLS de organização + admin, FK composta com o canal,
 *     cascade, CHECK de estado e um eco por wamid;
 *   - `fn_meta_ecos_correlacionar` classifica SÓ o eco cujo wamid é
 *     `media_placeholder` com `from_me` no history DA MESMA janela, só de
 *     `aguardando`, e não toca messages/event_log/contacts/conversations;
 *   - duas chamadas simultâneas não classificam o mesmo eco duas vezes;
 *   - a janela de cada payload (`onboarding_em`) sai do backfill da migration,
 *     que é idempotente;
 *   - a função não é executável por anon nem por authenticated;
 *   - a IDENTIDADE inclui a janela: o mesmo wamid (quarentena) e o mesmo pedaço
 *     (payload) em O1 e O2 são linhas distintas, e cada janela só correlaciona
 *     com a sua.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;
const PSQL = ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"];

function sql(script: string): string {
  return execFileSync("docker", PSQL, { input: script, encoding: "utf8" }).trim();
}

async function sqlAssincrono(script: string): Promise<string> {
  const filho = promisify(execFile)("docker", PSQL, { encoding: "utf8" });
  filho.child.stdin?.end(script);
  return (await filho).stdout.trim();
}

/** A última linha do resultado. O `SET` do `set role` não é resultado: com a função devolvendo vazio, sobraria só ele. */
function ultimaLinha(out: string): string {
  const linhas = out.split("\n").filter((l) => l !== "SET");
  return linhas[linhas.length - 1] ?? "";
}

function tentar(script: string): { ok: true; out: string } | { ok: false; erro: string } {
  try {
    return { ok: true, out: sql(script) };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return { ok: false, erro: String(e.stderr ?? e.message ?? err) };
  }
}

const ORG_A = "dddddddd-0000-4000-8000-0000000436aa";
const ORG_B = "dddddddd-0000-4000-8000-0000000436bb";
const ADMIN_A = "dddddddd-1111-4000-8000-0000000436aa";
const SESSAO_A = "dddddddd-2222-4000-8000-0000000436aa";
const SESSAO_B = "dddddddd-2222-4000-8000-0000000436bb";
const O1 = "2026-09-27T02:58:54.984Z";
const O2 = "2026-10-05T10:00:00Z";

/** Um pedaço de history com entradas (id, tipo, from_me), como jsonb literal. */
function historico(entradas: Array<[string, string, boolean]>): string {
  const mensagens = entradas.map(([id, tipo, fromMe]) => ({
    id,
    type: tipo,
    timestamp: "1790000000",
    history_context: fromMe ? { status: "delivered", from_me: true } : { status: "read" },
  }));
  return JSON.stringify({ history: [{ metadata: { phase: 1, chunk_order: 1, progress: 7 }, threads: [{ id: "5531988887777", messages: mensagens }] }] });
}

function eco(org: string, sessao: string, onboarding: string, wamid: string, estado = "aguardando"): string {
  return `insert into public.meta_ecos_em_espera (organization_id, channel_session_id, onboarding_em, external_id, phone_number_id, sent_at, bruto, estado)
    values ('${org}', '${sessao}', '${onboarding}', '${wamid}', '100000000000001', '2026-09-20T15:00:00Z', '{"id":"${wamid}"}'::jsonb, '${estado}');`;
}

const CONTAGEM = `
  select (select count(*) from public.event_log) || '|' || (select count(*) from public.messages) || '|' ||
         (select count(*) from public.conversations) || '|' || (select count(*) from public.contacts);`;

const correlacionar = (onboarding: string) =>
  `set role service_role; select string_agg(wamid, ',' order by wamid) from public.fn_meta_ecos_correlacionar('${ORG_A}', '${SESSAO_A}', '${onboarding}');`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_A}', 'ecos-0436-a@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ecos-0436-a', 'Ecos 0436 A', 'Ecos A'),
      ('${ORG_B}', 'ecos-0436-b', 'Ecos 0436 B', 'Ecos B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'ecos-0436-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'ecos-0436-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
  `);
});

describe("ecos do app em espera (0436) — a correlação no banco", () => {
  it("classifica SÓ o placeholder `from_me` da MESMA janela; nada fora da quarentena muda", () => {
    sql(`
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em) values
        ('${ORG_A}', '${SESSAO_A}', 'history', '${historico([
          ["wamid.SIM", "media_placeholder", true],
          ["wamid.CLIENTE", "media_placeholder", false],
          ["wamid.TEXTO", "text", true],
          ["wamid.O2", "media_placeholder", true],
        ])}'::jsonb, 'h-436-o1', '${O1}'),
        ('${ORG_A}', '${SESSAO_A}', 'history', '${historico([
          ["wamid.SO_O2", "media_placeholder", true],
          ["wamid.O2_PROPRIO", "media_placeholder", true],
        ])}'::jsonb, 'h-436-o2', '${O2}');
      ${eco(ORG_A, SESSAO_A, O1, "wamid.SIM")}
      ${eco(ORG_A, SESSAO_A, O1, "wamid.CLIENTE")}
      ${eco(ORG_A, SESSAO_A, O1, "wamid.TEXTO")}
      ${eco(ORG_A, SESSAO_A, O1, "wamid.SO_O2")}
      ${eco(ORG_A, SESSAO_A, O2, "wamid.O2")}
      ${eco(ORG_A, SESSAO_A, O2, "wamid.O2_PROPRIO")}
    `);
    const antes = ultimaLinha(sql(CONTAGEM));

    // wamid.O2 é placeholder no history de O1, mas o eco é de O2; wamid.SO_O2 é
    // placeholder no history de O2, mas o eco é de O1. Nenhum dos dois casa.
    // wamid.O2_PROPRIO é o controle: eco e placeholder da MESMA janela O2.
    expect(ultimaLinha(sql(correlacionar(O1)))).toBe("wamid.SIM");
    expect(ultimaLinha(sql(correlacionar(O2)))).toBe("wamid.O2_PROPRIO");

    const estados = ultimaLinha(
      sql(`select string_agg(external_id || '=' || estado, ',' order by external_id) from public.meta_ecos_em_espera where organization_id = '${ORG_A}';`),
    );
    expect(estados).toBe(
      "wamid.CLIENTE=aguardando,wamid.O2=aguardando,wamid.O2_PROPRIO=historico,wamid.SIM=historico,wamid.SO_O2=aguardando,wamid.TEXTO=aguardando",
    );
    expect(ultimaLinha(sql(CONTAGEM))).toBe(antes);
  });

  it("chamada repetida não reclassifica nada; eco já promovido nunca vira histórico", () => {
    sql(`${eco(ORG_A, SESSAO_A, O1, "wamid.PROMOVIDO", "promovido")}
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em)
        values ('${ORG_A}', '${SESSAO_A}', 'history', '${historico([["wamid.PROMOVIDO", "media_placeholder", true]])}'::jsonb, 'h-436-prom', '${O1}');`);
    expect(ultimaLinha(sql(correlacionar(O1)))).toBe("");
    expect(ultimaLinha(sql(`select estado from public.meta_ecos_em_espera where external_id = 'wamid.PROMOVIDO';`))).toBe("promovido");
  });

  it("duas chamadas SIMULTÂNEAS classificam o eco uma vez só", async () => {
    sql(`${eco(ORG_A, SESSAO_A, O1, "wamid.CORRIDA")}
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em)
        values ('${ORG_A}', '${SESSAO_A}', 'history', '${historico([["wamid.CORRIDA", "media_placeholder", true]])}'::jsonb, 'h-436-corrida', '${O1}');`);
    const [a, b] = await Promise.all([sqlAssincrono(correlacionar(O1)), sqlAssincrono(correlacionar(O1))]);
    const devolvidos = [ultimaLinha(a), ultimaLinha(b)].filter((x) => x !== "");
    expect(devolvidos).toEqual(["wamid.CORRIDA"]);
  });

  it("history malformado (history/threads/messages que não são lista) não derruba a correlação", () => {
    sql(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em) values
      ('${ORG_A}', '${SESSAO_A}', 'history', '{"history":{"x":1}}'::jsonb, 'h-436-mal1', '${O1}'),
      ('${ORG_A}', '${SESSAO_A}', 'history', '{"history":[{"threads":"x"},{"threads":[{"messages":7}]},3]}'::jsonb, 'h-436-mal2', '${O1}');
      ${eco(ORG_A, SESSAO_A, O1, "wamid.MAL")}`);
    expect(tentar(correlacionar(O1)).ok).toBe(true);
  });
});

describe("ecos do app em espera (0436) — a tabela", () => {
  it("um eco por wamid POR JANELA: repetir na mesma janela é recusado", () => {
    const r = tentar(eco(ORG_A, SESSAO_A, O1, "wamid.SIM"));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.erro).toContain("meta_ecos_em_espera_um_por_wamid_na_janela");
  });

  it("CHECK recusa estado fora do vocabulário", () => {
    expect(tentar(eco(ORG_B, SESSAO_B, O1, "wamid.X", "importado")).ok).toBe(false);
  });

  it("FK composta: o eco da organização A não se pendura no canal da B", () => {
    const r = tentar(eco(ORG_A, SESSAO_B, O1, "wamid.CRUZADO"));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.erro).toContain("meta_ecos_em_espera_sessao_fk");
  });

  it("nem o admin da PRÓPRIA organização lê pela anon/authenticated — só o servidor", () => {
    const r = tentar(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
      select count(*) from public.meta_ecos_em_espera;`);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.erro).toContain("permission denied");
    expect(tentar(`set role anon; select count(*) from public.meta_ecos_em_espera;`).ok).toBe(false);
  });

  it("RLS ligada com policy de organização COM papel admin", () => {
    expect(ultimaLinha(sql(`select relrowsecurity from pg_class where oid = 'public.meta_ecos_em_espera'::regclass;`))).toBe("t");
    const policy = ultimaLinha(
      sql(`select coalesce(qual, '') || coalesce(with_check, '') from pg_policies
            where schemaname = 'public' and tablename = 'meta_ecos_em_espera' and policyname = 'tenant_isolation_meta_ecos_em_espera_all';`),
    );
    expect(policy).toContain("fn_user_org_ids");
    expect(policy).toContain("fn_role_at_least");
  });

  it("nenhum grant de escrita a anon/authenticated/PUBLIC", () => {
    const grants = sql(`select grantee || ':' || privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'meta_ecos_em_espera' and grantee in ('anon','authenticated','PUBLIC');`);
    expect(grants).toBe("");
  });

  it("a função não é executável por anon nem por authenticated", () => {
    const acl = ultimaLinha(
      sql(`select has_function_privilege('anon', 'public.fn_meta_ecos_correlacionar(uuid,uuid,timestamptz)', 'EXECUTE')::text || '|' ||
                  has_function_privilege('authenticated', 'public.fn_meta_ecos_correlacionar(uuid,uuid,timestamptz)', 'EXECUTE')::text || '|' ||
                  has_function_privilege('service_role', 'public.fn_meta_ecos_correlacionar(uuid,uuid,timestamptz)', 'EXECUTE')::text;`),
    );
    expect(acl).toBe("false|false|true");
  });

  it("o canal apagado leva a quarentena junto (cascade) — dado pessoal não fica órfão", () => {
    const temp = "dddddddd-2222-4000-8000-0000000436cc";
    sql(`
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${temp}', '${ORG_B}', 'ecos-0436-temp', '\\x00'::bytea);
      ${eco(ORG_B, temp, O1, "wamid.TEMP")}
      delete from public.channel_sessions where id = '${temp}';`);
    expect(ultimaLinha(sql(`select count(*) from public.meta_ecos_em_espera where channel_session_id = '${temp}';`))).toBe("0");
  });
});

describe("ecos do app em espera (0436) — a identidade inclui a janela (O1 × O2)", () => {
  /** A correlação na organização B, que nenhum outro bloco deste arquivo usa. */
  const correlacionarB = (onboarding: string) =>
    `set role service_role; select string_agg(wamid, ',' order by wamid) from public.fn_meta_ecos_correlacionar('${ORG_B}', '${SESSAO_B}', '${onboarding}');`;
  const estadoB = (onboarding: string, wamid: string) =>
    ultimaLinha(
      sql(`select estado from public.meta_ecos_em_espera
            where organization_id = '${ORG_B}' and channel_session_id = '${SESSAO_B}' and onboarding_em = '${onboarding}' and external_id = '${wamid}';`),
    );
  const constraintExiste = (tabela: string, nome: string) =>
    ultimaLinha(sql(`select count(*) from pg_constraint where conname = '${nome}' and conrelid = 'public.${tabela}'::regclass;`));

  it("as uniques antigas (sem janela) não existem mais; as novas sim", () => {
    expect(constraintExiste("meta_ecos_em_espera", "meta_ecos_em_espera_um_por_wamid")).toBe("0");
    expect(constraintExiste("meta_ecos_em_espera", "meta_ecos_em_espera_um_por_wamid_na_janela")).toBe("1");
    expect(constraintExiste("meta_sincronizacao_payloads", "meta_sincronizacao_payloads_uma_entrega")).toBe("0");
    expect(constraintExiste("meta_sincronizacao_payloads", "meta_sincronizacao_payloads_uma_entrega_na_janela")).toBe("1");
  });

  it("o MESMO wamid em O1 e em O2 são duas linhas — O1 não bloqueia O2", () => {
    sql(`${eco(ORG_B, SESSAO_B, O1, "wamid.DUPLO")}
         ${eco(ORG_B, SESSAO_B, O2, "wamid.DUPLO")}`);
    expect(ultimaLinha(sql(`select count(*) from public.meta_ecos_em_espera where channel_session_id = '${SESSAO_B}' and external_id = 'wamid.DUPLO';`))).toBe("2");
    const repetido = tentar(eco(ORG_B, SESSAO_B, O2, "wamid.DUPLO"));
    expect(repetido.ok).toBe(false);
    expect(repetido.ok ? "" : repetido.erro).toContain("meta_ecos_em_espera_um_por_wamid_na_janela");
  });

  it("O2 correlaciona com O2 sem tocar a linha de O1; depois O1 correlaciona com O1", () => {
    sql(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em)
           values ('${ORG_B}', '${SESSAO_B}', 'history', '${historico([["wamid.DUPLO", "media_placeholder", true]])}'::jsonb, 'h-duplo', '${O2}');`);
    expect(ultimaLinha(sql(correlacionarB(O1)))).toBe("");
    expect(ultimaLinha(sql(correlacionarB(O2)))).toBe("wamid.DUPLO");
    expect(estadoB(O1, "wamid.DUPLO")).toBe("aguardando");
    expect(estadoB(O2, "wamid.DUPLO")).toBe("historico");

    // O MESMO pedaço (mesmo hash), agora recebido na janela O1: é outra linha, não 23505.
    sql(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em)
           values ('${ORG_B}', '${SESSAO_B}', 'history', '${historico([["wamid.DUPLO", "media_placeholder", true]])}'::jsonb, 'h-duplo', '${O1}');`);
    expect(ultimaLinha(sql(correlacionarB(O1)))).toBe("wamid.DUPLO");
    expect(estadoB(O1, "wamid.DUPLO")).toBe("historico");
  });

  it("payload: o mesmo hash é recusado na MESMA janela, e também sem janela (nulls not distinct)", () => {
    const naMesma = tentar(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, onboarding_em)
      values ('${ORG_B}', '${SESSAO_B}', 'history', '{}'::jsonb, 'h-duplo', '${O2}');`);
    expect(naMesma.ok).toBe(false);
    expect(naMesma.ok ? "" : naMesma.erro).toContain("meta_sincronizacao_payloads_uma_entrega_na_janela");

    sql(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash)
           values ('${ORG_B}', '${SESSAO_B}', 'smb_app_state_sync', '{}'::jsonb, 'h-sem-janela');`);
    const semJanela = tentar(`insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash)
      values ('${ORG_B}', '${SESSAO_B}', 'smb_app_state_sync', '{}'::jsonb, 'h-sem-janela');`);
    expect(semJanela.ok).toBe(false);
    expect(semJanela.ok ? "" : semJanela.erro).toContain("meta_sincronizacao_payloads_uma_entrega_na_janela");
  });
});

describe("ecos do app em espera (0436) — a janela de cada payload (backfill)", () => {
  /** O bloco de backfill, extraído da própria migration — mede o que o clone roda. */
  const backfill = (() => {
    const mig = readFileSync(
      join(__dirname, "..", "..", "supabase", "migrations", "20260927033747_0436_ecos_do_app_em_espera.sql"),
      "utf8",
    );
    const i = mig.indexOf("with janelas as (");
    return mig.slice(i, mig.indexOf(";", i) + 1);
  })();

  it("carimba cada payload com a janela [onboarding, próximo onboarding) em que foi recebido; reaplicar não muda nada", () => {
    sql(`
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo) values
        ('${ORG_B}', '${SESSAO_B}', '2026-09-01T00:00:00Z', 'historico'),
        ('${ORG_B}', '${SESSAO_B}', '2026-09-10T00:00:00Z', 'historico')
        on conflict do nothing;
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, recebido_em) values
        ('${ORG_B}', '${SESSAO_B}', 'history', '{}'::jsonb, 'bf-antes', '2026-08-20T00:00:00Z'),
        ('${ORG_B}', '${SESSAO_B}', 'history', '{}'::jsonb, 'bf-o1', '2026-09-05T00:00:00Z'),
        ('${ORG_B}', '${SESSAO_B}', 'history', '{}'::jsonb, 'bf-o2', '2026-09-12T00:00:00Z');`);
    const ler = () =>
      ultimaLinha(
        sql(`select string_agg(payload_hash || '=' || coalesce(to_char(onboarding_em at time zone 'UTC', 'MM-DD'), 'null'), ',' order by payload_hash)
               from public.meta_sincronizacao_payloads where channel_session_id = '${SESSAO_B}' and payload_hash like 'bf-%';`),
      );
    sql(backfill);
    expect(ler()).toBe("bf-antes=null,bf-o1=09-01,bf-o2=09-10");
    sql(backfill);
    expect(ler()).toBe("bf-antes=null,bf-o1=09-01,bf-o2=09-10");
  });
});
