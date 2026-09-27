import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A SINCRONIZAÇÃO DO APP (0420) GUARDA E NÃO FAZ MAIS NADA — e não vaza.
 *
 * O risco desta fase não é o que ela faz, é o que um engano faria: uma linha de
 * histórico em `messages` dispara `message.received` (IA, push, fluxos), e uma
 * conversa nova pede distribuição. Aqui se mede NO BANCO, com os triggers reais:
 * guardar payloads e mexer nos pedidos não muda `event_log`, `messages`,
 * `conversations` nem `contacts`.
 *
 * E o isolamento: as tabelas são só do servidor (sem grant para `authenticated`
 * nem `anon`); a FK composta impede pendurar o payload de uma organização no
 * canal de outra; a unicidade segura a reentrega da Meta.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function ultimaLinha(out: string): string {
  const linhas = out.split("\n");
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

const ORG_A = "cccccccc-0000-4000-8000-0000000419aa";
const ORG_B = "cccccccc-0000-4000-8000-0000000419bb";
const ADMIN_A = "cccccccc-1111-4000-8000-0000000419aa";
const SESSAO_A = "cccccccc-2222-4000-8000-0000000419aa";
const SESSAO_B = "cccccccc-2222-4000-8000-0000000419bb";

/** O onboarding dos pedidos semeados — SQL literal. */
const ONBOARDING = "'2026-09-26T00:43:08Z'";

const CONTAGEM = `
  select (select count(*) from public.event_log) || '|' ||
         (select count(*) from public.messages) || '|' ||
         (select count(*) from public.conversations) || '|' ||
         (select count(*) from public.contacts);`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_A}', 'sync-0419-a@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'sync-0419-a', 'Sync 0419 A', 'Sync A'),
      ('${ORG_B}', 'sync-0419-b', 'Sync 0419 B', 'Sync B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'sync-0419-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'sync-0419-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
  `);
});

describe("sincronização do app (0420) — preservação sem efeitos", () => {
  it("guardar payloads e mexer nos pedidos NÃO toca event_log, messages, conversations nem contacts", () => {
    const antes = ultimaLinha(sql(CONTAGEM));
    sql(`
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo)
        values ('${ORG_A}', '${SESSAO_A}', ${ONBOARDING}, 'contatos'), ('${ORG_A}', '${SESSAO_A}', ${ONBOARDING}, 'historico')
        on conflict (channel_session_id, onboarding_em, tipo) do nothing;
      update public.meta_sincronizacoes set status = 'solicitada', request_id = 'req-x', solicitada_em = now()
        where channel_session_id = '${SESSAO_A}';
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash, fase, chunk_order, progresso)
        values
        ('${ORG_A}', '${SESSAO_A}', 'history',
         '{"history":[{"metadata":{"phase":0,"chunk_order":1,"progress":55},"threads":[{"id":"16505551234","messages":[{"from":"16505551234","id":"wamid.INV1","timestamp":"1739230955","type":"text","text":{"body":"oi"}}]}]}]}'::jsonb,
         'hash-historico-1', 0, 1, 55),
        ('${ORG_A}', '${SESSAO_A}', 'smb_app_state_sync',
         '{"state_sync":[{"type":"contact","contact":{"full_name":"Pablo","phone_number":"16505551234"},"action":"add"}]}'::jsonb,
         'hash-contatos-1', null, null, null);
      update public.meta_sincronizacoes set recebido_em = now() where channel_session_id = '${SESSAO_A}';
    `);
    expect(ultimaLinha(sql(CONTAGEM))).toBe(antes);
  });

  it("a reentrega (mesmo canal, janela, campo e hash) é recusada com 23505 — inclusive sem janela", () => {
    const r = tentar(`
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash)
        values ('${ORG_A}', '${SESSAO_A}', 'history', '{}'::jsonb, 'hash-historico-1');`);
    expect(r.ok).toBe(false);
    // A chave da 0420 era (canal, campo, hash); a 0436 incluiu a janela, com
    // `nulls not distinct` — este pedaço não tem janela e continua deduplicado.
    expect(r.ok ? "" : r.erro).toContain("meta_sincronizacao_payloads_uma_entrega_na_janela");
  });

  it("um pedido por (canal, onboarding, tipo): o mesmo onboarding recusa o segundo", () => {
    const r = tentar(`
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo)
        values ('${ORG_A}', '${SESSAO_A}', ${ONBOARDING}, 'contatos');`);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.erro).toContain("meta_sincronizacoes_uma_por_onboarding");
  });

  it("um onboarding NOVO do mesmo canal aceita pedido novo — e o do anterior continua lá", () => {
    const antes = ultimaLinha(sql(`select count(*) from public.meta_sincronizacoes where channel_session_id = '${SESSAO_A}' and onboarding_em = ${ONBOARDING};`));
    sql(`
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo)
        values ('${ORG_A}', '${SESSAO_A}', '2026-10-10T12:00:00Z', 'contatos');`);
    expect(ultimaLinha(sql(`select count(*) from public.meta_sincronizacoes where channel_session_id = '${SESSAO_A}' and onboarding_em = ${ONBOARDING};`))).toBe(antes);
    expect(ultimaLinha(sql(`select count(*) from public.meta_sincronizacoes where channel_session_id = '${SESSAO_A}';`))).toBe(String(Number(antes) + 1));
  });

  it("onboarding_em é obrigatório", () => {
    expect(
      tentar(`insert into public.meta_sincronizacoes (organization_id, channel_session_id, tipo) values ('${ORG_B}', '${SESSAO_B}', 'contatos');`).ok,
    ).toBe(false);
  });

  it("FK composta: o payload da organização A não se pendura no canal da B", () => {
    const r = tentar(`
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash)
        values ('${ORG_A}', '${SESSAO_B}', 'history', '{}'::jsonb, 'hash-cruzado');`);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.erro).toContain("meta_sincronizacao_payloads_sessao_fk");
    const s = tentar(`
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo)
        values ('${ORG_A}', '${SESSAO_B}', ${ONBOARDING}, 'historico');`);
    expect(s.ok).toBe(false);
  });

  it.each([
    ["tipo", `insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo) values ('${ORG_B}', '${SESSAO_B}', ${ONBOARDING}, 'mensagens');`],
    ["status", `insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo, status) values ('${ORG_B}', '${SESSAO_B}', ${ONBOARDING}, 'contatos', 'importada');`],
    ["campo", `insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash) values ('${ORG_B}', '${SESSAO_B}', 'messages', '{}'::jsonb, 'h');`],
  ])("CHECK recusa valor fora do vocabulário em %s", (_c, dml) => {
    expect(tentar(dml).ok).toBe(false);
  });

  it.each(["meta_sincronizacoes", "meta_sincronizacao_payloads"])(
    "%s: nem o admin da PRÓPRIA organização lê pela anon/authenticated — só o servidor",
    (tabela) => {
      const r = tentar(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
        select count(*) from public.${tabela};`);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.erro).toContain("permission denied");
      const anon = tentar(`set role anon; select count(*) from public.${tabela};`);
      expect(anon.ok).toBe(false);
    },
  );

  it.each(["meta_sincronizacoes", "meta_sincronizacao_payloads"])("%s: RLS ligada e policy de organização COM papel admin", (tabela) => {
    expect(ultimaLinha(sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`))).toBe("t");
    const policy = ultimaLinha(
      sql(`select coalesce(qual, '') || coalesce(with_check, '') from pg_policies
            where schemaname = 'public' and tablename = '${tabela}' and policyname = 'tenant_isolation_${tabela}_all';`),
    );
    expect(policy).toContain("fn_user_org_ids");
    expect(policy).toContain("fn_role_at_least");
  });

  it("service_role lê (é o caminho do servidor)", () => {
    const n = ultimaLinha(sql(`set role service_role; select count(*) from public.meta_sincronizacao_payloads where organization_id = '${ORG_A}';`));
    expect(Number(n)).toBeGreaterThanOrEqual(2);
  });

  it("nenhum trigger nas tabelas novas além do updated_at", () => {
    const gatilhos = sql(`
      select tgname from pg_trigger
       where not tgisinternal
         and tgrelid in ('public.meta_sincronizacoes'::regclass, 'public.meta_sincronizacao_payloads'::regclass)
       order by 1;`);
    expect(gatilhos).toBe("trg_meta_sincronizacoes_updated_at");
  });

  it("o canal apagado leva os pedidos e os payloads junto (cascade) — dado pessoal não fica órfão", () => {
    const sessaoTemp = "cccccccc-2222-4000-8000-0000000419cc";
    sql(`
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sessaoTemp}', '${ORG_B}', 'sync-0419-temp', '\\x00'::bytea);
      insert into public.meta_sincronizacoes (organization_id, channel_session_id, onboarding_em, tipo) values ('${ORG_B}', '${sessaoTemp}', ${ONBOARDING}, 'contatos');
      insert into public.meta_sincronizacao_payloads (organization_id, channel_session_id, campo, payload, payload_hash)
        values ('${ORG_B}', '${sessaoTemp}', 'smb_app_state_sync', '{}'::jsonb, 'h-temp');
      delete from public.channel_sessions where id = '${sessaoTemp}';`);
    expect(
      ultimaLinha(sql(`
        select (select count(*) from public.meta_sincronizacoes where channel_session_id = '${sessaoTemp}')
             + (select count(*) from public.meta_sincronizacao_payloads where channel_session_id = '${sessaoTemp}');`)),
    ).toBe("0");
  });
});
