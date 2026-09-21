-- 0312: o registro de TAGS, o registro de CAMPOS DO CONTATO e os DISPAROS.
--
-- ── O buraco que esta migration fecha ────────────────────────────────────────
--
-- O Flow Builder (0311) deixou o gatilho escolhível, mas duas das coisas que
-- ele configura não EXISTEM como entidade: a etiqueta e o campo personalizado.
--
--   tag     — vive só como string dentro de `contacts.tags text[]` e de uma
--             lista solta em `organizations.settings.tags`. A tela de Tags
--             mostra o que JÁ foi escrito por alguém; não há como criar uma
--             antes de usá-la, nem id para uma integração citar.
--   campo   — `contacts.custom_fields` (0211) guarda o VALOR, e a definição
--             mora em `crm_pipelines.settings.fields[]`, que é do FUNIL. Um
--             campo do contato numa instalação sem funil configurado não tem
--             onde ser declarado, e o nó ACTION pedia a chave DIGITADA.
--
-- Os dois ganham tabela com id estável. O que NÃO muda, de propósito: a
-- etiqueta continua sendo `text[]` onde é aplicada e o valor do campo continua
-- em `custom_fields jsonb`. Trocar por FK quebraria automação, webhook
-- (`lead.tag_added`), MCP e o contrato da API — a doutrina de
-- `lib/schemas/tags.ts` já registrou isso. O registro é o VOCABULÁRIO, não o
-- valor.
--
-- ── Por que a chave do campo é imutável ──────────────────────────────────────
--
-- `contacts.custom_fields` é indexado por `key`, e `{{contact.custom_fields.<key>}}`
-- é o que vai escrito dentro da mensagem de um flow já publicado. Deixar a
-- chave editável faria renomear um campo apagar em silêncio a variável de toda
-- mensagem que a cita. Então: `key` nasce com o campo e não muda; `label` (o
-- nome que aparece na tela) muda à vontade. É isto que dá o "vínculo que
-- sobrevive ao rename" — o id e a chave são estáveis, o nome é enfeite.
--
-- ── Disparos ────────────────────────────────────────────────────────────────
--
-- Envio em massa com relógio próprio, no mesmo padrão dos outros motores do
-- produto: fila em tabela + claim atômico com lease + cron. NÃO é um laço
-- síncrono percorrendo contatos — um disparo de 5.000 pessoas dentro de um
-- handler HTTP morreria no timeout com metade enviada e nenhum registro de onde
-- parou. A idempotência é estrutural: `unique (broadcast_id, contact_id)`,
-- então reprocessar um lote nunca manda a segunda mensagem para a mesma pessoa.
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TAGS — o vocabulário com id
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O nome É a chave de aplicação: é ele que entra em `contacts.tags`. Renomear
  -- aqui exige renomear lá, e quem faz isso numa transação só é
  -- `fn_vocabulario_de_tags_operar` (0264) — o registro é sincronizado logo
  -- depois, por `fn_tag_registro_aplicar`, abaixo.
  name text not null check (btrim(name) <> '' and length(name) <= 60),
  -- Pasta é só agrupamento visual. Texto livre, e não tabela: pasta vazia não é
  -- entidade que alguém queira administrar, e FK aqui obrigaria a criar a pasta
  -- antes da primeira tag.
  folder text not null default 'Tags' check (length(folder) <= 60),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  description text check (description is null or length(description) <= 500),
  archived_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uma linha por nome canônico. `lower()` porque "VIP" e "vip" são a mesma
-- etiqueta para todo o resto do produto (`fn_vocabulario_de_tags` agrupa assim).
create unique index if not exists idx_tags_org_nome
  on public.tags (organization_id, lower(btrim(name)));
create index if not exists idx_tags_org_pasta on public.tags (organization_id, folder);

alter table public.tags enable row level security;

drop policy if exists "tags_select" on public.tags;
drop policy if exists "tags_manager_write" on public.tags;
create policy "tags_select" on public.tags
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "tags_manager_write" on public.tags
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- ── Backfill: o registro nasce com o que a organização JÁ usa ────────────────
--
-- Sem isto a tela nova abriria vazia numa instalação com 200 etiquetas em uso,
-- e o operador concluiria que perdeu o vocabulário. Fonte: as etiquetas
-- aplicadas (contatos, negócios, conversas) e a lista curada em
-- `organizations.settings.tags`. `on conflict do nothing` torna re-aplicável.
insert into public.tags (organization_id, name, folder)
select distinct on (u.organization_id, lower(u.tag))
       u.organization_id, u.tag, 'Tags'
from (
  select c.organization_id, nullif(btrim(t.valor), '') as tag
    from public.contacts c, unnest(coalesce(c.tags, '{}'::text[])) as t(valor)
  union all
  select l.organization_id, nullif(btrim(t.valor), '')
    from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) as t(valor)
  union all
  select v.organization_id, nullif(btrim(t.valor), '')
    from public.conversations v, unnest(coalesce(v.tags, '{}'::text[])) as t(valor)
  union all
  select o.id, nullif(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')), '')
    from public.organizations o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.settings -> 'tags') = 'array'
           then o.settings -> 'tags' else '[]'::jsonb end
    ) as e(valor)
) u
where u.tag is not null and u.tag <> '' and length(u.tag) <= 60
order by u.organization_id, lower(u.tag), u.tag
on conflict do nothing;

-- ── Sincronizar o registro quando o vocabulário é renomeado/juntado/excluído ──
--
-- `fn_vocabulario_de_tags_operar` (0264) é quem reescreve as etiquetas
-- APLICADAS (contatos, negócios, conversas e as regras `add_tag` dos agentes)
-- numa transação só. Esta função cuida só do REGISTRO, e é chamada logo depois,
-- pela mesma rota. Separada de propósito: a 0264 é uma função de 300 linhas
-- vinda de outra fatia, e enxertar o registro dentro dela pediria reescrevê-la
-- inteira para ganhar atomicidade sobre METADADO — o id, a pasta e a cor. Se o
-- registro ficar para trás, o pior caso é uma linha órfã na tela de Tags, que a
-- própria tela deixa excluir; nenhuma mensagem sai errada por causa disso.
create or replace function public.fn_tag_registro_aplicar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text
) returns jsonb
  language plpgsql
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_destino_id uuid;
  v_origem_id uuid;
begin
  if p_acao not in ('renomear', 'juntar', 'excluir') then
    raise exception 'acao_invalida' using errcode = '22023';
  end if;

  select id into v_origem_id from public.tags
   where organization_id = p_org and lower(btrim(name)) = lower(btrim(p_tag));

  if p_acao = 'excluir' then
    delete from public.tags
     where organization_id = p_org and lower(btrim(name)) = lower(btrim(p_tag));
    return jsonb_build_object('registro', 'excluido');
  end if;

  if p_acao = 'renomear' then
    -- Renomear PRESERVA o id: é o ponto inteiro de ter id. Uma integração que
    -- guardou o uuid continua apontando para a mesma etiqueta depois do rename.
    if v_origem_id is null then
      insert into public.tags (organization_id, name) values (p_org, btrim(p_destino))
      on conflict do nothing;
    else
      update public.tags set name = btrim(p_destino), updated_at = now()
       where id = v_origem_id;
    end if;
    return jsonb_build_object('registro', 'renomeado', 'id', v_origem_id);
  end if;

  -- juntar: a de ORIGEM deixa de existir; o destino sobrevive (e nasce, se
  -- ainda não estiver no registro).
  insert into public.tags (organization_id, name) values (p_org, btrim(p_destino))
  on conflict do nothing;
  select id into v_destino_id from public.tags
   where organization_id = p_org and lower(btrim(name)) = lower(btrim(p_destino));
  delete from public.tags
   where organization_id = p_org and lower(btrim(name)) = lower(btrim(p_tag));
  return jsonb_build_object('registro', 'juntado', 'destino_id', v_destino_id);
end;
$$;

revoke all on function public.fn_tag_registro_aplicar(uuid, text, text, text) from public;
revoke execute on function public.fn_tag_registro_aplicar(uuid, text, text, text) from anon;
grant execute on function public.fn_tag_registro_aplicar(uuid, text, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. CAMPOS DO CONTATO — a definição com id
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.contact_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- IMUTÁVEL depois de criado (ver cabeçalho). É a chave dentro de
  -- `contacts.custom_fields` e o que `{{contact.custom_fields.<key>}}` cita.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (btrim(label) <> '' and length(label) <= 80),
  description text check (description is null or length(description) <= 500),
  -- Os seis tipos que a tela oferece, MAIS os do vocabulário legado de
  -- `crm_pipelines.settings.fields[]` (`customFieldSchema` em
  -- lib/schemas/settings.ts), porque o backfill abaixo traz esses campos para cá
  -- e descartar o tipo deles transformaria um select em texto livre sem aviso.
  type text not null default 'text' check (
    type in ('text', 'number', 'date', 'datetime', 'boolean', 'list',
             'textarea', 'select', 'multiselect', 'email', 'phone', 'url')
  ),
  -- Opções de select/multiselect, no mesmo formato de `customFieldSchema`:
  -- [{ "value": "...", "label": "..." }]. Vazio para os demais tipos.
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  folder text not null default 'Campos do Usuário' check (length(folder) <= 60),
  -- Arquivar, não excluir: o VALOR continua em `contacts.custom_fields` e uma
  -- mensagem publicada pode citar a chave. Arquivado some dos seletores e
  -- continua legível no contato.
  archived_at timestamptz,
  position numeric not null default 0,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_contact_fields_org_key
  on public.contact_fields (organization_id, lower(key));
create index if not exists idx_contact_fields_org_ordem
  on public.contact_fields (organization_id, folder, position);

alter table public.contact_fields enable row level security;

drop policy if exists "contact_fields_select" on public.contact_fields;
drop policy if exists "contact_fields_manager_write" on public.contact_fields;
create policy "contact_fields_select" on public.contact_fields
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "contact_fields_manager_write" on public.contact_fields
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- ── Backfill: os campos que já estavam declarados no funil ───────────────────
--
-- `crm_pipelines.settings.fields[]` era a ÚNICA declaração de campo do contato
-- (comentário da 0211). Quem já configurou campos lá os encontra na tela nova
-- com a MESMA chave — e como a chave é o índice de `contacts.custom_fields`, os
-- valores já gravados continuam aparecendo.
insert into public.contact_fields (organization_id, key, label, type, options, folder, position)
select distinct on (p.organization_id, lower(f.valor ->> 'key'))
       p.organization_id,
       lower(f.valor ->> 'key'),
       coalesce(nullif(btrim(coalesce(f.valor ->> 'label', '')), ''), f.valor ->> 'key'),
       coalesce(nullif(f.valor ->> 'type', ''), 'text'),
       case when jsonb_typeof(f.valor -> 'options') = 'array'
            then f.valor -> 'options' else '[]'::jsonb end,
       'Campos do Usuário',
       0
from public.crm_pipelines p
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(p.settings -> 'fields') = 'array'
       then p.settings -> 'fields' else '[]'::jsonb end
) as f(valor)
where nullif(btrim(coalesce(f.valor ->> 'key', '')), '') is not null
  and lower(f.valor ->> 'key') ~ '^[a-z][a-z0-9_]{0,39}$'
  and length(coalesce(nullif(btrim(coalesce(f.valor ->> 'label', '')), ''), f.valor ->> 'key')) <= 80
  and coalesce(nullif(f.valor ->> 'type', ''), 'text') in
      ('text', 'number', 'date', 'datetime', 'boolean', 'list',
       'textarea', 'select', 'multiselect', 'email', 'phone', 'url')
order by p.organization_id, lower(f.valor ->> 'key'), p.created_at
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. DISPAROS — envio em massa com fila, lease e idempotência
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  status text not null default 'draft' check (
    status in ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')
  ),
  -- A SEGMENTAÇÃO, no formato que `lib/disparos/segmento.ts` lê:
  -- { "tags_all": [], "tags_any": [], "tags_none": [], "fields": [{key,op,value}] }
  -- jsonb e não colunas porque o conjunto de critérios cresce (item 10 do
  -- pedido: combinação de filtros), e cada critério novo seria uma migration.
  segment jsonb not null default '{}'::jsonb check (jsonb_typeof(segment) = 'object'),
  -- A mensagem, no MESMO vocabulário do nó MESSAGE do flow (lib/flows/types.ts):
  -- window_mode inside_24h|outside_24h, body / template_name / template_language /
  -- template_values / channel_session_id. Um só vocabulário para "mandar
  -- WhatsApp" no produto inteiro.
  message jsonb not null default '{}'::jsonb check (jsonb_typeof(message) = 'object'),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  total_recipients int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  last_error text,
  -- Relógio próprio: o worker só volta a este disparo depois de `next_run_at`.
  -- É o que dá o ritmo anti-banimento sem `sleep` dentro do handler.
  next_run_at timestamptz,
  claimed_until timestamptz,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_broadcasts_org_status on public.broadcasts (organization_id, status);
create index if not exists idx_broadcasts_due
  on public.broadcasts (next_run_at)
  where status in ('scheduled', 'running');

create table if not exists public.broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'sent', 'failed', 'skipped')
  ),
  error text,
  sent_at timestamptz,
  attempts int not null default 0,
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A IDEMPOTÊNCIA DO DISPARO, e ela é ESTRUTURAL. Rematerializar o público
-- (porque alguém clicou duas vezes, porque o worker reiniciou no meio) não pode
-- gerar uma segunda linha para a mesma pessoa — e como só há uma linha, só há
-- um envio. Sem este índice, a prevenção de duplicidade dependeria de o código
-- lembrar de conferir.
create unique index if not exists idx_broadcast_recipients_unico
  on public.broadcast_recipients (broadcast_id, contact_id);
create index if not exists idx_broadcast_recipients_pendentes
  on public.broadcast_recipients (broadcast_id, status)
  where status = 'pending';

alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;

drop policy if exists "broadcasts_select" on public.broadcasts;
drop policy if exists "broadcasts_manager_write" on public.broadcasts;
create policy "broadcasts_select" on public.broadcasts
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "broadcasts_manager_write" on public.broadcasts
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- Destinatário é só LEITURA pela RLS: quem escreve é o worker com admin client,
-- filtrando organization_id à mão (anti-pattern 10 do CLAUDE.md). Mesma régua
-- de flow_executions.
drop policy if exists "broadcast_recipients_select" on public.broadcast_recipients;
create policy "broadcast_recipients_select" on public.broadcast_recipients
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- ═══ Claim atômico do disparo, mesmo padrão de fn_claim_due_flow_executions ═══
create or replace function public.fn_claim_due_broadcasts(p_limit int, p_lease_seconds int)
returns setof public.broadcasts
language sql
security definer
set search_path = public
as $$
  update public.broadcasts b
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where b.id in (
    select id from public.broadcasts
    where status in ('scheduled', 'running')
      and coalesce(next_run_at, scheduled_at, now()) <= now()
      and (claimed_until is null or claimed_until < now())
    order by coalesce(next_run_at, scheduled_at, created_at)
    limit p_limit
    for update skip locked
  )
  returning b.*;
$$;

revoke all on function public.fn_claim_due_broadcasts(int, int) from public, anon, authenticated;

-- ═══ Claim atômico do LOTE de destinatários ═══
--
-- Duas camadas de claim, e as duas são necessárias: a de cima impede dois
-- workers pegando o mesmo disparo; esta impede dois workers pegando o mesmo
-- destinatário caso o lease de cima vença no meio de um lote demorado.
create or replace function public.fn_claim_due_broadcast_recipients(
  p_broadcast uuid, p_limit int, p_lease_seconds int
)
returns setof public.broadcast_recipients
language sql
security definer
set search_path = public
as $$
  update public.broadcast_recipients r
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      attempts = r.attempts + 1,
      updated_at = now()
  where r.id in (
    select id from public.broadcast_recipients
    where broadcast_id = p_broadcast
      and status = 'pending'
      and (claimed_until is null or claimed_until < now())
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning r.*;
$$;

revoke all on function public.fn_claim_due_broadcast_recipients(uuid, int, int) from public, anon, authenticated;

-- ═══ A FRONTEIRA DE SERVIÇO do disparo, ancorada na AUTORIZAÇÃO ═══
--
-- Esta é a parte do disparo que não podia ser improvisada. Toda mensagem que
-- sai do produto passa por `sendMessageHandler`, e ele exige uma
-- `ServiceBoundary` — o recibo de que existe atendimento aberto com aquele
-- contato naquele canal. Há três jeitos de consegui-la, e dois não servem aqui:
--
--   serviceForEvent       exige um `event_log.id` cujo tipo esteja nas
--                         allowlists PAREADas de `fn_service_event_origin`.
--                         Um disparo não nasce de evento, e enfiá-lo naquela
--                         função (300 linhas vindas de dump) para ganhar um
--                         caso a mais é justamente o que a 0311 já pagou caro.
--   beginServiceAtOrigin  é explícito: "só chamadores internos AUTORIZADORES;
--                         nunca usado por job/tick/retry". O worker é um tick.
--
-- Sobra o caminho que o follow-up já usa e que é o certo: ancorar a fronteira
-- no momento da AUTORIZAÇÃO (o manager clicando "Agendar") e GUARDÁ-LA na
-- linha, como `followup_enrollments.service_boundary` faz. O worker não cria
-- autorização nenhuma — ele reconfere a que já estava lá
-- (`assertServiceBoundarySupabase`) e, se o mundo mudou, recusa.
--
-- E ancora as N de uma vez DENTRO do banco, em vez de N chamadas RPC do
-- handler: 2.000 destinatários seriam 2.000 idas e voltas de rede dentro de um
-- request HTTP, que é exatamente o timeout que esta arquitetura veio evitar.
--
-- Contato que não consegue fronteira (sem canal, anonimizado, mesclado) NÃO
-- derruba o disparo inteiro: nasce `skipped` com o motivo real do banco. Um
-- disparo de 500 pessoas não pode morrer por causa de uma.

alter table public.broadcast_recipients
  add column if not exists service_boundary jsonb;

create or replace function public.fn_broadcast_materializar(
  p_broadcast uuid,
  p_org uuid,
  p_contact_ids uuid[]
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_contact uuid;
  v_boundary jsonb;
  v_inseridos int := 0;
  v_pulados int := 0;
begin
  if not exists (select 1 from public.broadcasts where id = p_broadcast and organization_id = p_org) then
    raise exception 'broadcast_not_found' using errcode = 'P0002';
  end if;

  foreach v_contact in array coalesce(p_contact_ids, array[]::uuid[])
  loop
    begin
      -- `p_observed => null` pula o CAS de `fn_service_begin` de propósito: o
      -- CAS existe para arbitrar dois ATORES com a mesma observação "ausente",
      -- e aqui há um ator só, o operador que clicou.
      v_boundary := public.fn_service_begin(p_org, v_contact);
      insert into public.broadcast_recipients
        (organization_id, broadcast_id, contact_id, status, service_boundary)
      values (p_org, p_broadcast, v_contact, 'pending', v_boundary)
      on conflict (broadcast_id, contact_id) do nothing;
      if found then v_inseridos := v_inseridos + 1; end if;
    exception when others then
      insert into public.broadcast_recipients
        (organization_id, broadcast_id, contact_id, status, error)
      values (p_org, p_broadcast, v_contact, 'skipped', left(sqlerrm, 300))
      on conflict (broadcast_id, contact_id) do nothing;
      if found then v_pulados := v_pulados + 1; end if;
    end;
  end loop;

  update public.broadcasts b
     set total_recipients = (select count(*) from public.broadcast_recipients r where r.broadcast_id = p_broadcast),
         skipped_count    = (select count(*) from public.broadcast_recipients r where r.broadcast_id = p_broadcast and r.status = 'skipped'),
         updated_at = now()
   where b.id = p_broadcast and b.organization_id = p_org;

  return jsonb_build_object('inseridos', v_inseridos, 'pulados', v_pulados);
end;
$$;

revoke all on function public.fn_broadcast_materializar(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_broadcast_materializar(uuid, uuid, uuid[]) to service_role;

-- ═══ A operação de etiqueta numa transação só ═══
--
-- `fn_vocabulario_de_tags_operar` (0264) reescreve a etiqueta APLICADA
-- (contatos, negócios, conversas e as regras `add_tag` dos agentes);
-- `fn_tag_registro_aplicar` (acima) cuida do REGISTRO, preservando o id. A
-- primeira versão desta fatia chamava as duas em sequência DA ROTA — duas idas
-- ao banco, duas transações, e uma janela entre elas em que o vocabulário já
-- estava renomeado e o registro não.
--
-- Este invólucro fecha a janela sem tocar em nenhuma das duas: ele as chama no
-- mesmo corpo, logo na mesma transação. Se o registro levantar, o rename das
-- etiquetas aplicadas volta atrás junto — que é o comportamento que se quer, e
-- que duas chamadas de rota não conseguem dar.
--
-- SECURITY INVOKER de propósito: quem cobra papel são as funções chamadas. A de
-- baixo é `security definer` e tem o próprio gate (`fn_role_at_least`); a do
-- registro é `invoker` e depende da RLS de `public.tags`. Um `definer` aqui
-- passaria por cima da segunda e daria ao invólucro mais poder do que qualquer
-- uma das partes tem.
create or replace function public.fn_tag_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text
) returns jsonb
  language plpgsql
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_vocabulario jsonb;
  v_registro jsonb;
begin
  v_vocabulario := public.fn_vocabulario_de_tags_operar(p_org, p_acao, p_tag, p_destino);
  v_registro := public.fn_tag_registro_aplicar(p_org, p_acao, p_tag, p_destino);
  -- Um objeto só, com o resultado das duas metades. A rota audita o conjunto.
  return coalesce(v_vocabulario, '{}'::jsonb) || coalesce(v_registro, '{}'::jsonb);
end;
$$;

revoke all on function public.fn_tag_operar(uuid, text, text, text) from public;
revoke execute on function public.fn_tag_operar(uuid, text, text, text) from anon;
grant execute on function public.fn_tag_operar(uuid, text, text, text) to authenticated, service_role;
