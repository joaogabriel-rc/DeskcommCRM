-- 9253 · As policies de `organizations` deixam de valer para `anon`.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- `orgs_select` e `orgs_write_platform_admin` foram criadas sem `TO`, isto é,
-- para `public` — e `public` inclui `anon`. As duas chamam helpers SECURITY
-- DEFINER (`fn_user_org_ids()`, `fn_is_platform_admin()`) dos quais a 0108
-- revogou o EXECUTE de `anon`, de propósito (issue #128). Resultado: toda
-- leitura anônima de `organizations` avalia a policy, tropeça no helper e o
-- Postgres registra `ERROR: permission denied for function fn_user_org_ids`;
-- o PostgREST devolve 401.
--
-- Quem faz essa leitura é o health (`app/api/v1/health/route.ts`): o ping do
-- banco é `GET /rest/v1/organizations?select=id&limit=1` com a anon key. Medido
-- na produção em 08/11/2026: 45 chamadas ao health entre 04h13 e 04h48 UTC,
-- 45 respostas 401 nesse caminho no gateway e 45 `permission denied` no log do
-- Postgres — um erro de banco por verificação de saúde, que suja o log e
-- esconde erro real. O health aceitava o 401 como "ok", então nada quebrava.
--
-- ─── O conserto ─────────────────────────────────────────────────────────────
-- `alter policy ... to authenticated`. Nada se concede: `anon` deixa de ter
-- policy aplicável e, com RLS ligada, passa a enxergar ZERO linhas (200 com
-- `[]`) sem avaliar helper nenhum. Nenhum fluxo anônimo perde acesso, porque
-- nenhum tinha: toda leitura anônima de `organizations` já terminava em
-- `permission denied`. `authenticated` mantém exatamente as mesmas expressões
-- (`using`/`with check` não são tocados pelo `alter policy ... to`), e
-- `service_role` segue ignorando RLS.
--
-- Mesmo desenho das policies `support_write_*` desta tabela, que já nasceram
-- `to authenticated`.
--
-- Idempotente: `alter policy ... to` reaplicado é no-op. Sem dado reescrito.
-- O `do`/`if exists` protege clone onde a policy foi renomeada à mão.

do $$
begin
  if exists (select 1 from pg_policy
              where polname = 'orgs_select'
                and polrelid = 'public.organizations'::regclass) then
    execute 'alter policy "orgs_select" on public.organizations to authenticated';
  end if;
  if exists (select 1 from pg_policy
              where polname = 'orgs_write_platform_admin'
                and polrelid = 'public.organizations'::regclass) then
    execute 'alter policy "orgs_write_platform_admin" on public.organizations to authenticated';
  end if;
end $$;
