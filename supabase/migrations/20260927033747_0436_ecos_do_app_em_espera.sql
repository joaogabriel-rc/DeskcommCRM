-- 0436 · Ecos do app WhatsApp Business em espera — a quarentena do eco suspeito.
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
-- Durante a sincronização do histórico (0420), parte da MÍDIA histórica que a
-- empresa mandou pelo aplicativo chega pelo campo `smb_message_echoes` — o mesmo
-- do eco ao vivo. O `ingestMetaEcho` não tinha como distinguir: 38 mídias de 14 a
-- 26/09 viraram mensagem nova, criaram 10 contatos e 10 conversas e pausaram a IA
-- em 13 conversas, numa reconexão de 27/09. Os 38 wamids estão no `history`
-- guardado como `media_placeholder` com `history_context.from_me = true`; nenhuma
-- das 31.871 mensagens do history é posterior ao onboarding.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
--   meta_ecos_em_espera          o eco SUSPEITO (timestamp anterior ao onboarding)
--                                guardado BRUTO, sem virar mensagem, contato,
--                                conversa, pausa nem evento. Um por wamid POR
--                                JANELA: o mesmo wamid em O1 e O2 são duas linhas.
--   meta_sincronizacao_payloads  ganha `onboarding_em`: a qual janela o payload
--                                pertence. Sem ela, um pedaço atrasado do onboarding
--                                anterior seria lido como do atual. A unique de
--                                entrega passa a incluir a janela (a da 0420 não
--                                incluía, e o mesmo pedaço numa reconexão ficava
--                                preso à janela antiga).
--   fn_meta_ecos_correlacionar   classifica como `historico` os ecos em espera cujo
--                                wamid é placeholder `from_me` no history DAQUELE
--                                onboarding. Só marca estado: não cria mensagem.
--
-- O timestamp é só a porta de suspeita; a classificação definitiva é pelo wamid.
-- A promoção de um eco tardio (history terminou e o wamid não apareceu) é feita
-- pelo servidor (`lib/channels/meta/resolver-ecos-em-espera.ts`), pelo mesmo
-- caminho do eco ao vivo.
--
-- ─── Exposição ──────────────────────────────────────────────────────────────
-- Como as tabelas da 0420: só o servidor lê e escreve; RLS por organização E papel
-- admin como segunda barreira; o bruto carrega dado pessoal e sai em cascade com
-- o canal. A função é `security definer`, sem EXECUTE para public/anon/
-- authenticated.
--
-- Vocabulário do CHECK em `lib/channels/meta/ecos-em-espera.ts`, cobrado pelo
-- invariante de vocabulário. Idempotente.

-- ─── A janela de cada payload ───────────────────────────────────────────────

alter table public.meta_sincronizacao_payloads add column if not exists onboarding_em timestamptz;

-- Backfill: cada payload pertence ao onboarding [O_i, O_i+1) do seu canal em que
-- foi recebido. As janelas vêm dos pedidos (um por onboarding) e do onboarding
-- atual do canal. Só toca linha ainda sem janela — reaplicar não muda nada.
with janelas as (
  select o.channel_session_id,
         o.onboarding_em,
         lead(o.onboarding_em) over (partition by o.channel_session_id order by o.onboarding_em) as proximo
    from (
      select distinct s.channel_session_id, s.onboarding_em from public.meta_sincronizacoes s
      union
      select c.id, c.meta_onboarding_em from public.channel_sessions c where c.meta_onboarding_em is not null
    ) o
)
update public.meta_sincronizacao_payloads p
   set onboarding_em = j.onboarding_em
  from janelas j
 where p.onboarding_em is null
   and j.channel_session_id = p.channel_session_id
   and p.recebido_em >= j.onboarding_em
   and (j.proximo is null or p.recebido_em < j.proximo);

create index if not exists meta_sincronizacao_payloads_janela_idx
  on public.meta_sincronizacao_payloads (organization_id, channel_session_id, onboarding_em)
  where campo = 'history';

-- A identidade de um payload INCLUI a janela. A `unique (channel_session_id,
-- campo, payload_hash)` da 0420 misturava onboardings: o mesmo pedaço reenviado
-- depois de uma reconexão caía em 23505 e ficava só com a janela ANTIGA, e a
-- correlação da janela nova nunca o lia. `nulls not distinct` (Postgres 15, o
-- piso do produto): o pedaço de canal SEM onboarding continua deduplicado na
-- reentrega. A troca não precisa de deduplicação: a chave nova é mais larga que
-- a antiga, então todo dado que satisfazia a antiga satisfaz a nova.
alter table public.meta_sincronizacao_payloads drop constraint if exists meta_sincronizacao_payloads_uma_entrega;
do $uq$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'meta_sincronizacao_payloads_uma_entrega_na_janela'
       and conrelid = 'public.meta_sincronizacao_payloads'::regclass
  ) then
    alter table public.meta_sincronizacao_payloads
      add constraint meta_sincronizacao_payloads_uma_entrega_na_janela
      unique nulls not distinct (channel_session_id, onboarding_em, campo, payload_hash);
  end if;
end
$uq$;

-- ─── A quarentena ───────────────────────────────────────────────────────────

create table if not exists public.meta_ecos_em_espera (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  -- O onboarding do canal quando o eco chegou. A correlação só lê o history
  -- DESTA janela; uma reconexão abre outra e não enxerga esta.
  onboarding_em timestamptz not null,
  external_id text not null,
  phone_number_id text not null,
  waba_id text,
  sent_at timestamptz not null,
  recebido_em timestamptz not null default now(),
  -- O item de `message_echoes[]` como a Meta mandou, com as chaves que o parser
  -- ignora. É dele que a promoção reconstrói o eco.
  bruto jsonb not null,
  estado text not null default 'aguardando',
  motivo text,
  decidido_em timestamptz,
  -- Reservado ao importador de history: quando a mídia deste eco for usada para
  -- preencher o placeholder correspondente.
  consumido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_ecos_em_espera_sessao_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete cascade,
  constraint meta_ecos_em_espera_estado_check check (estado = any (array[
    'aguardando'::text, 'historico'::text, 'promovido'::text, 'duplicado'::text])),
  constraint meta_ecos_em_espera_um_por_wamid_na_janela unique (organization_id, channel_session_id, onboarding_em, external_id)
);

-- Um eco por wamid POR JANELA. O mesmo wamid pode chegar em O1 e, depois de uma
-- reconexão, em O2: são duas linhas, cada uma decidida pelo history da SUA janela
-- — O1 não bloqueia O2. Quem aplicou uma versão anterior desta migration tinha a
-- unique por (organização, canal, wamid): ela sai, e a chave nova (mais larga)
-- entra sem deduplicar nada.
alter table public.meta_ecos_em_espera drop constraint if exists meta_ecos_em_espera_um_por_wamid;
do $uq$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'meta_ecos_em_espera_um_por_wamid_na_janela'
       and conrelid = 'public.meta_ecos_em_espera'::regclass
  ) then
    alter table public.meta_ecos_em_espera
      add constraint meta_ecos_em_espera_um_por_wamid_na_janela
      unique (organization_id, channel_session_id, onboarding_em, external_id);
  end if;
end
$uq$;

create index if not exists meta_ecos_em_espera_janela_idx
  on public.meta_ecos_em_espera (organization_id, channel_session_id, onboarding_em, estado);

drop trigger if exists trg_meta_ecos_em_espera_updated_at on public.meta_ecos_em_espera;
create trigger trg_meta_ecos_em_espera_updated_at before update on public.meta_ecos_em_espera
  for each row execute function public.fn_set_updated_at();

alter table public.meta_ecos_em_espera enable row level security;

drop policy if exists tenant_isolation_meta_ecos_em_espera_all on public.meta_ecos_em_espera;
create policy tenant_isolation_meta_ecos_em_espera_all on public.meta_ecos_em_espera
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'admin'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'admin'));

revoke all on public.meta_ecos_em_espera from anon, authenticated;
grant select, insert, update, delete on public.meta_ecos_em_espera to service_role;

comment on table public.meta_ecos_em_espera is
  'Ecos do app WhatsApp Business (smb_message_echoes) com timestamp anterior ao onboarding: guardados brutos, sem virar mensagem, até a correlação com o history do mesmo onboarding decidir se são mídia histórica (historico) ou eco tardio (promovido).';

-- ─── A correlação ───────────────────────────────────────────────────────────
--
-- Uma passada pelo history DA JANELA (organização, canal, onboarding), nunca uma
-- por eco: a leitura linha a linha estoura o statement_timeout com ~30 mil
-- entradas. Só marca estado, e só de `aguardando` — o `where estado =
-- 'aguardando'` é o guarda contra dois resolvedores ao mesmo tempo e contra
-- reclassificar um eco já promovido.
create or replace function public.fn_meta_ecos_correlacionar(p_org uuid, p_sessao uuid, p_onboarding timestamptz)
returns table (wamid text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.meta_ecos_em_espera q
     where q.organization_id = p_org and q.channel_session_id = p_sessao
       and q.onboarding_em = p_onboarding and q.estado = 'aguardando'
  ) then
    return;
  end if;

  return query
  with placeholders as materialized (
    select distinct m->>'id' as id
      from public.meta_sincronizacao_payloads p
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(p.payload->'history') = 'array' then p.payload->'history' else '[]'::jsonb end) h
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(h->'threads') = 'array' then h->'threads' else '[]'::jsonb end) t
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t->'messages') = 'array' then t->'messages' else '[]'::jsonb end) m
     where p.organization_id = p_org
       and p.channel_session_id = p_sessao
       and p.onboarding_em = p_onboarding
       and p.campo = 'history'
       and jsonb_typeof(m) = 'object'
       and m->>'type' = 'media_placeholder'
       and m->'history_context'->>'from_me' = 'true'
  )
  update public.meta_ecos_em_espera q
     set estado = 'historico', motivo = 'wamid_no_historico', decidido_em = now()
    from placeholders ph
   where q.organization_id = p_org
     and q.channel_session_id = p_sessao
     and q.onboarding_em = p_onboarding
     and q.estado = 'aguardando'
     and q.external_id = ph.id
  returning q.external_id;
end;
$$;

revoke execute on function public.fn_meta_ecos_correlacionar(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_meta_ecos_correlacionar(uuid, uuid, timestamptz) to service_role;

comment on function public.fn_meta_ecos_correlacionar(uuid, uuid, timestamptz) is
  'Classifica como historico os ecos em espera da janela cujo wamid é media_placeholder from_me no history guardado da MESMA janela. Só estado; nunca cria mensagem. Devolve os wamids classificados.';
