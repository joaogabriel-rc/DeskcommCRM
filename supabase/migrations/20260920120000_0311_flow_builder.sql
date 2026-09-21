-- 0311: Flow Builder — automações visuais de WhatsApp (estilo ManyChat)
--
-- Terceiro motor do produto, de propósito: automação (event_log, sem relógio
-- próprio) e follow-up (grafo + enrollment + next_eval_at, cadência de
-- reengajamento) já existem e não fundem (doutrina "UM grafo, UM enrollment,
-- UM relógio" por domínio — ver .specs/features/crm-automacao-fluxos/design.md).
-- O Flow Builder precisa de ESPERA (delay + resposta de botão), que é
-- exatamente o que a automação de event_log recusa fazer — então ganha o
-- próprio relógio (flow_executions.next_execution_at + claim atômico), no
-- mesmo padrão do follow-up, e reusa tudo o mais (envio WhatsApp, ações de
-- tag/etapa/campo, anti-SSRF do webhook) em vez de duplicar.
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  -- ⚠️ TAG É UM DOS GATILHOS, NÃO O FLOW. O vocabulário vive em
  -- `lib/flows/triggers.ts` (catálogo com o `event_type` real de cada um) e é
  -- espelhado aqui como CHECK para o banco recusar gatilho inventado. Gatilho
  -- novo entra nos dois — o invariante
  -- `tests/invariants/vocabulario-banco-x-typescript.test.ts` cobre colunas com
  -- CHECK exatamente para isto.
  trigger_type text not null default 'contact_tag_added' check (
    trigger_type in (
      'contact_created', 'contact_tag_added', 'contact_tag_removed', 'contact_field_changed',
      'contact_birthday', 'whatsapp_message_received',
      'lead_created', 'lead_stage_changed', 'lead_won', 'lead_lost',
      'appointment_created', 'appointment_confirmed', 'appointment_cancelled'
    )
  ),
  trigger_config jsonb not null default '{}'::jsonb,
  -- Versão do desenho. O motor NÃO pina execução em voo numa versão (a regra
  -- é a mesma da automação: editar exige pausar), mas o número sobe a cada
  -- save publicado e é o que a Atividade mostra para explicar "este contato
  -- entrou pelo desenho antigo".
  version integer not null default 1,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_flows_org_status on public.flows (organization_id, status);
-- Índice de seleção do gatilho: o handler pergunta "quais flows ATIVOS desta
-- organização escutam este gatilho?" a cada evento.
--
-- NÃO é único: N flows podem escutar o mesmo gatilho, e os N rodam — é o
-- comportamento que a automação de `event_log` já tem ("duas regras ativas
-- batem no mesmo evento: ambas rodam"). A primeira versão desta migration
-- tinha um índice ÚNICO por tag, o que impedia dois flows na mesma tag; era
-- restrição inventada por mim, não pedida pelo produto, e some aqui.
create index if not exists idx_flows_org_trigger
  on public.flows (organization_id, trigger_type)
  where status = 'active';

create table if not exists public.flow_nodes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  -- TRIGGER (e não TAG_TRIGGER): o nó de entrada guarda QUAL gatilho o flow
  -- escuta, e a tag é só a configuração de um deles. MESSAGE absorveu os
  -- botões (cada botão é uma SAÍDA do próprio nó, como na referência) — não há
  -- nó BUTTONS separado.
  type text not null check (
    type in ('TRIGGER', 'MESSAGE', 'CONDITION', 'ACTION', 'DELAY', 'WEBHOOK', 'END')
  ),
  label text not null default '',
  config jsonb not null default '{}'::jsonb,
  position_x numeric not null default 0,
  position_y numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_flow_nodes_flow on public.flow_nodes (flow_id);

create table if not exists public.flow_edges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  source_node_id uuid not null references public.flow_nodes(id) on delete cascade,
  target_node_id uuid not null references public.flow_nodes(id) on delete cascade,
  -- Rótulo da saída de onde a aresta parte: null (saída única), ou
  -- 'button:<index>' (um botão do nó MESSAGE), 'true'/'false' (CONDITION).
  source_handle text,
  created_at timestamptz not null default now()
);

create index if not exists idx_flow_edges_flow on public.flow_edges (flow_id);
create index if not exists idx_flow_edges_source on public.flow_edges (source_node_id);

create table if not exists public.flow_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'running' check (
    status in ('running', 'waiting', 'completed', 'failed', 'cancelled')
  ),
  current_node_id uuid references public.flow_nodes(id) on delete set null,
  -- Por que espera: 'button_reply' (BUTTONS aguardando o cliente escolher) ou
  -- 'delay' (nó DELAY aguardando o relógio). Null quando status != 'waiting'.
  waiting_for text check (waiting_for in ('button_reply', 'delay')),
  waiting_node_id uuid references public.flow_nodes(id) on delete set null,
  -- Variáveis resolvidas ao longo da execução ({{contact.*}} + o que ACTION
  -- grava) — snapshot, não ponteiro: sobrevive a tag/campo mudando depois.
  context jsonb not null default '{}'::jsonb,
  -- O event_log.id que iniciou esta execução (idempotência de trigger duplo).
  trigger_event_id uuid,
  next_execution_at timestamptz,
  claimed_until timestamptz,
  attempts int not null default 0,
  last_error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_flow_executions_org_status on public.flow_executions (organization_id, status);
create index if not exists idx_flow_executions_contact on public.flow_executions (contact_id);
create index if not exists idx_flow_executions_due
  on public.flow_executions (next_execution_at)
  where status = 'waiting' and waiting_for = 'delay';
create index if not exists idx_flow_executions_waiting_reply
  on public.flow_executions (organization_id, contact_id)
  where status = 'waiting' and waiting_for = 'button_reply';

-- Idempotência (CLAUDE.md doutrina + pedido explícito): no máximo UMA execução
-- em voo (running|waiting) por par (flow, contact). Duas emissões do MESMO
-- evento de tag (ex.: o trigger novo E uma ação de automação que também
-- emitiu) colidem aqui em vez de abrir duas conversas paralelas — a 2ª tentativa
-- de INSERT recebe 23505 e o handler trata como "já em andamento", não como erro.
create unique index if not exists idx_flow_executions_one_active_per_contact
  on public.flow_executions (flow_id, contact_id)
  where status in ('running', 'waiting');

create table if not exists public.flow_execution_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  execution_id uuid not null references public.flow_executions(id) on delete cascade,
  node_id uuid references public.flow_nodes(id) on delete set null,
  event_type text not null check (
    event_type in ('entered', 'completed', 'failed', 'waiting', 'resumed', 'skipped')
  ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_flow_execution_events_execution
  on public.flow_execution_events (execution_id, created_at);

alter table public.flows enable row level security;
alter table public.flow_nodes enable row level security;
alter table public.flow_edges enable row level security;
alter table public.flow_executions enable row level security;
alter table public.flow_execution_events enable row level security;

-- Mesmo padrão da 0038 (webhooks/automation_rules): select p/ membro da org,
-- write manager+. Execuções/eventos: só select (escrita é sempre admin client
-- no engine/worker, que bypassa RLS e filtra organization_id manualmente —
-- anti-pattern 10 do CLAUDE.md).

drop policy if exists "flows_select" on public.flows;
drop policy if exists "flows_manager_write" on public.flows;
create policy "flows_select" on public.flows
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "flows_manager_write" on public.flows
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

drop policy if exists "flow_nodes_select" on public.flow_nodes;
drop policy if exists "flow_nodes_manager_write" on public.flow_nodes;
create policy "flow_nodes_select" on public.flow_nodes
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "flow_nodes_manager_write" on public.flow_nodes
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

drop policy if exists "flow_edges_select" on public.flow_edges;
drop policy if exists "flow_edges_manager_write" on public.flow_edges;
create policy "flow_edges_select" on public.flow_edges
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "flow_edges_manager_write" on public.flow_edges
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

drop policy if exists "flow_executions_select" on public.flow_executions;
create policy "flow_executions_select" on public.flow_executions
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists "flow_execution_events_select" on public.flow_execution_events;
create policy "flow_execution_events_select" on public.flow_execution_events
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- ═══ Gatilho: qualquer caminho que adicione tag a um contato acorda o Flow ═══
--
-- Trigger Postgres NUNCA faz HTTP (doutrina) — só grava em event_log; quem
-- consome é o handler TS registrado no dispatcher (lib/flows/trigger.handler.ts).
-- Cobre TODO escritor de contacts.tags uniformemente: PATCH da UI, N8N via
-- Bearer dsk_ no /api/v1/contacts, MCP, bulk, e a ação add_tag da automação —
-- sem isso, só o caminho que alguém lembrasse de instrumentar disparava o Flow,
-- e o caso de uso pedido ("N8N adiciona tag → dispara Flow") é justamente um
-- escritor que não passa pelo código da automação.
--
-- fn_log_event deriva entity_kind='contact' de 'contact.tag_added' (split
-- antes do ponto) e entity_id de payload->>'contact_id' — union com o padrão
-- já usado por fn_emit_event_on_lead_change.
create or replace function public.fn_emit_event_on_contact_tags_change() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_new_tag text;
  v_gone_tag text;
begin
  if tg_op = 'UPDATE' and new.tags is distinct from old.tags then
    -- A REMOÇÃO também é gatilho ("Tag removida do contato"), e o evento
    -- `contact.tag_removed` não existia em lugar nenhum do produto: foi
    -- implementado aqui em vez de a opção ser oferecida na tela a seco.
    for v_gone_tag in
      select t from unnest(coalesce(old.tags, '{}'::text[])) as t
      except
      select t from unnest(coalesce(new.tags, '{}'::text[])) as t
    loop
      if v_gone_tag = 'cliente' and old.client_tag_by_system is not null then
        continue;
      end if;
      perform public.fn_log_event(
        new.organization_id,
        'contact.tag_removed',
        jsonb_build_object('contact_id', new.id, 'tag', v_gone_tag,
                          'removed_tags', jsonb_build_array(v_gone_tag), 'tags', new.tags)
      );
    end loop;

    for v_new_tag in
      select t from unnest(new.tags) as t
      except
      select t from unnest(coalesce(old.tags, '{}'::text[])) as t
    loop
      -- A etiqueta 'cliente' do reconhecimento por agendamento
      -- (fn_colunas_de_cliente_sao_do_sistema, migration 0262) é classificação
      -- do SISTEMA, não ação de marketing — disparar Flow nela inundaria de
      -- WhatsApp toda instalação que reconhecer clientes em massa (medido no
      -- teste de origem: 630 eventos no estúdio do autor). client_tag_by_system
      -- não nulo, depois daquele BEFORE trigger, é a marca de que esta escrita
      -- é do sistema — só a etiqueta 'cliente' é pulada; outra tag no mesmo
      -- UPDATE continua disparando normalmente.
      if v_new_tag = 'cliente' and new.client_tag_by_system is not null then
        continue;
      end if;
      perform public.fn_log_event(
        new.organization_id,
        -- `added_tags` (plural) é a forma que os consumidores JÁ leem: a ação
        -- `add_tag` da automação emite assim, e regra com `event.added_tags
        -- contains X` depende dela. `tag` (singular) é a conveniência do Flow.
        'contact.tag_added',
        jsonb_build_object('contact_id', new.id, 'tag', v_new_tag,
                          'added_tags', jsonb_build_array(v_new_tag), 'tags', new.tags)
      );
    end loop;
  end if;
  return new;
end;
$$;

-- As DUAS origens de EXECUTE, mesmo sendo função de GATILHO (item 9 do
-- CLAUDE.md, e o mesmo bloco que `fn_contato_anonimizado_limpa_campos_personalizados`
-- já escreve neste arquivo).
--
-- Postgres recusa invocar direto uma função `returns trigger` fora do contexto
-- de trigger, então o EXECUTE aqui é inerte na prática — a razão de revogar
-- assim mesmo é não deixar UMA função de gatilho fora do padrão que todas as
-- outras seguem: a exceção é o que a próxima cópia herda, e a varredura de
-- `hardening-definer-varredura.test.ts` só alcança `security definer`.
revoke all on function public.fn_emit_event_on_contact_tags_change() from public;
revoke execute on function public.fn_emit_event_on_contact_tags_change() from anon;
revoke execute on function public.fn_emit_event_on_contact_tags_change() from authenticated;

drop trigger if exists trg_emit_event_on_contact_tags_change on public.contacts;
create trigger trg_emit_event_on_contact_tags_change
  after update on public.contacts
  for each row execute function public.fn_emit_event_on_contact_tags_change();

-- ═══ Relógio do nó DELAY: claim atômico, mesmo padrão de
--     fn_claim_due_followup_enrollments (migration 0054) ═══
create or replace function public.fn_claim_due_flow_executions(p_limit int, p_lease_seconds int)
returns setof public.flow_executions
language sql
security definer
set search_path = public
as $$
  update public.flow_executions e
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where e.id in (
    select id from public.flow_executions
    where status = 'waiting'
      and waiting_for = 'delay'
      and next_execution_at <= now()
      and (claimed_until is null or claimed_until < now())
    order by next_execution_at
    limit p_limit
    for update skip locked
  )
  returning e.*;
$$;

revoke all on function public.fn_claim_due_flow_executions(int, int) from public, anon, authenticated;

-- ═══ Salvar o grafo inteiro (canvas → banco) atomicamente ═══
--
-- SECURITY INVOKER de propósito: roda com o papel de quem chama (o manager
-- logado), então a RLS de flow_nodes/flow_edges cobra a organização de cada
-- linha escrita.
--
-- ⚠️ A RLS SOZINHA NÃO BASTA AQUI, e esta função já esteve errada por achar
-- que bastava. O `with check` das policies valida a COLUNA `organization_id`
-- da linha sendo inserida — nunca o dono do `flow_id` que ela referencia. Como
-- a função é `grant execute ... to authenticated`, ela é chamável direto pelo
-- PostgREST (`POST /rest/v1/rpc/fn_flow_replace_graph`) por QUALQUER manager de
-- QUALQUER organização, sem passar pela rota que confere a posse do flow.
--
-- Sem a guarda abaixo, esse chamador podia passar `p_flow_id` de uma
-- organização e `p_organization_id` da dele: a RLS aprovava (a linha nova tem
-- o `organization_id` dele), o `delete` não tocava nada da vítima (o `where`
-- exige as duas colunas), e o INSERT pendurava nós e arestas no flow alheio.
-- O motor, que lê o grafo com SERVICE ROLE, completava a cadeia carregando
-- esses nós dentro da execução da vítima.
--
-- Fechado nas DUAS pontas, porque uma só deixaria a outra de pé: aqui, o par
-- (flow, organização) tem de existir; e em `lib/flows/graph.ts`, a leitura do
-- motor filtra `organization_id` além de `flow_id`.
create or replace function public.fn_flow_replace_graph(
  p_flow_id uuid,
  p_organization_id uuid,
  p_nodes jsonb,
  p_edges jsonb
) returns void
  language plpgsql
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
begin
  -- A GUARDA. Antes de qualquer escrita: o flow existe E é desta organização?
  --
  -- `exists` e não `count`: basta saber que o par casa. O `raise` aborta a
  -- função inteira, então nem o `delete` nem os dois `insert` chegam a rodar —
  -- é isto que torna a recusa atômica em vez de "apagou e não escreveu".
  --
  -- P0002 (no_data_found) é o mesmo errcode que as outras funções deste
  -- schema usam para "não achei sob o seu escopo" (ver fn_broadcast_materializar),
  -- e a borda o traduz em 404 — nunca em "existe, mas não é seu", que
  -- confirmaria a existência de um flow de outra organização.
  if not exists (
    select 1 from public.flows
     where id = p_flow_id and organization_id = p_organization_id
  ) then
    raise exception 'flow_not_found_in_organization' using errcode = 'P0002';
  end if;

  delete from public.flow_edges where flow_id = p_flow_id and organization_id = p_organization_id;
  delete from public.flow_nodes where flow_id = p_flow_id and organization_id = p_organization_id;

  insert into public.flow_nodes (id, organization_id, flow_id, type, label, config, position_x, position_y)
  select
    (n ->> 'id')::uuid,
    p_organization_id,
    p_flow_id,
    n ->> 'type',
    coalesce(n ->> 'label', ''),
    coalesce(n -> 'config', '{}'::jsonb),
    coalesce((n ->> 'position_x')::numeric, 0),
    coalesce((n ->> 'position_y')::numeric, 0)
  from jsonb_array_elements(p_nodes) as n;

  insert into public.flow_edges (id, organization_id, flow_id, source_node_id, target_node_id, source_handle)
  select
    (e ->> 'id')::uuid,
    p_organization_id,
    p_flow_id,
    (e ->> 'source_node_id')::uuid,
    (e ->> 'target_node_id')::uuid,
    e ->> 'source_handle'
  from jsonb_array_elements(p_edges) as e;

  update public.flows set updated_at = now() where id = p_flow_id and organization_id = p_organization_id;
end;
$$;

revoke all on function public.fn_flow_replace_graph(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.fn_flow_replace_graph(uuid, uuid, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ═══ Dois eventos deixam de ser "registro sem consumidor" ═══
--
-- `fn_event_log_e_registro` (migration 0246) lista os eventos que NINGUÉM
-- consome: o trigger `trg_event_log_marca_registro` os marca `done` já no
-- INSERT, e o drain nunca os vê. É uma economia correta — enquanto não há
-- consumidor.
--
-- O Flow Builder passa a ser consumidor de dois deles: `contact.created` (o
-- gatilho "Novo contato criado") e `contact.updated` (o gatilho "Valor de um
-- campo do contato mudou"). Deixá-los na lista faria os dois gatilhos
-- aparecerem na tela, o operador montar o fluxo, ligar — e nada acontecer,
-- porque o evento morre antes do drain. Medido exatamente assim antes deste
-- bloco existir: execução nenhuma, evento `done` com `consumed_by` vazio.
--
-- Os demais da lista ficam como estão: nenhum gatilho do catálogo os usa.
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma
    -- ⚠️ `contact.created` e `contact.updated` SAÍRAM daqui (migration 0311):
    -- viraram gatilho do Flow Builder e precisam chegar ao drain.
    'contact.anonymized',
    'contact.deleted',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.reopened',
    'lead.risk_backlog_seeded',
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem
    'message.failed',
    'message.outbound',
    'message.sending',
    'message.sent',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;

revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- A lista sozinha não conserta nada: quem faz a linha nascer `done` é o
-- TRIGGER, e quem conserta o estoque é o BACKFILL. Religados aqui, idempotentes,
-- porque este arquivo mexeu na lista — a guarda
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` cobra os dois no MESMO
-- caminho de schema, e ela está certa: declarar a lista sem religar o mecanismo
-- passaria no teste da lista e não mudaria comportamento nenhum.
drop trigger if exists trg_event_log_marca_registro on public.event_log;
create trigger trg_event_log_marca_registro
  before insert on public.event_log
  for each row
  execute function public.fn_event_log_marca_registro();

-- Estoque: o que já está `pending` e continua sendo registro fecha aqui. Os dois
-- tipos que SAÍRAM da lista não são tocados — eles agora têm consumidor e o
-- drain é que decide o destino deles.
update public.event_log
   set status = 'done'
 where status = 'pending'
   and public.fn_event_log_e_registro(event_type);

notify pgrst, 'reload schema';

-- ═══ A FRONTEIRA DE SERVIÇO RECONHECE OS GATILHOS NOVOS (migration 0311) ═══
--
-- Envio automático só sai se a origem for VERIFICÁVEL: `emit_event` carimba
-- `service_origin` no instante da emissão e `fn_service_event_origin` o resolve
-- na hora do envio. As duas mantêm a MESMA allowlist de tipos de evento — e ela
-- cobria apenas lead.created/stage_changed/tag_added e contact.tag_added.
--
-- Medido antes deste bloco existir: um flow com gatilho "Novo contato criado"
-- criava a execução, entrava no nó de mensagem e morria em
-- `service_event_origin_unsupported`. O gatilho aparecia na tela e não
-- conseguia falar com ninguém.
--
-- O que ENTRA: os demais eventos de CONTATO (created/updated/tag_removed/
-- birthday, entity_kind='contact') e os de AGENDA (entity_kind=
-- 'calendar_appointment'). Em ambos a resolução do contato é inequívoca e as
-- verificações seguintes são as mesmas de sempre (entidade da organização,
-- contato confere, contato não anonimizado nem fundido). NENHUMA checagem foi
-- afrouxada — só a lista de tipos reconhecidos cresceu.
--
-- O que NÃO entra: `lead.won`/`lead.lost`. Eles nascem DENTRO do trigger de
-- `crm_leads` (fn_emit_event_on_lead_change) e o carimbo chamaria
-- `fn_service_observe_command` no caminho quente de todo UPDATE de negócio —
-- contenção que esta entrega não tem como medir com honestidade. Flow com esses
-- gatilhos roda ação, condição e webhook; o nó de mensagem recusa com motivo
-- explícito, e a tela avisa ANTES (lib/flows/triggers.ts, `mensagemSuportada`).

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  if auth.uid() is not null and p_event_type in ('message.received','appointment.outcome_confirmed') then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato repete a mesma regra de
  -- `fn_service_event_origin` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
      select contact_id into v_contact from public.crm_leads where organization_id=v_org_id and id=p_entity_id;
    elsif p_event_type in ('contact.tag_added','contact.tag_removed','contact.created','contact.updated','contact.birthday')
          and p_entity_kind='contact' then
      select id into v_contact from public.contacts where organization_id=v_org_id and id=p_entity_id;
    elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled')
          and p_entity_kind='calendar_appointment' then
      select contact_id into v_contact from public.calendar_appointments where organization_id=v_org_id and id=p_entity_id;
    end if;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_service_event_origin(p_org uuid, p_event uuid, p_contact uuid, p_session uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
begin
 -- O drain faz claim otimista em outra transação; não conserva row lock.
 -- Não travar event_log: advisory contato antecede os locks de conversa/FKs.
 perform public.fn_service_lock(p_org,p_contact);
 loop
 if root_event = any(visited) or cardinality(visited)>=32 then raise exception 'service_origin_cycle' using errcode='40001'; end if;
 visited:=array_append(visited,root_event);
 boundary:=null;
 entity_contact:=null;
 select * into e from public.event_log where organization_id=p_org and id=root_event;
 if not found then raise exception 'service_event_not_found' using errcode='P0002'; end if;
 if e.event_type in ('lead.created','lead.stage_changed','lead.tag_added') and e.entity_kind='crm_lead' then
   select contact_id into entity_contact from public.crm_leads where organization_id=p_org and id=e.entity_id;
 elsif e.event_type in ('contact.tag_added','contact.tag_removed','contact.created','contact.updated','contact.birthday') and e.entity_kind='contact' then
   select id into entity_contact from public.contacts where organization_id=p_org and id=e.entity_id;
 elsif e.event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled') and e.entity_kind='calendar_appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='appointment.outcome_confirmed' and e.entity_kind='appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id and revision=(e.payload->>'appointment_revision')::bigint and status='no_show' and outcome_recorded_at is not null;
 elsif e.event_type='message.received' and e.entity_kind='message' then
   select contact_id,jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,
     'conversation_id',conversation_id,'service_revision',service_revision,'demanda_id',demanda_id,'demanda_revision',demanda_revision)
     into entity_contact,boundary from public.messages where organization_id=p_org and id=e.entity_id and direction='inbound';
 else raise exception 'service_event_origin_unsupported' using errcode='40001'; end if;
 if entity_contact is distinct from p_contact or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 origin:=e.payload->'service_origin';
 if origin->>'kind'='event' then
   if origin->>'organization_id' is distinct from p_org::text or origin->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   root_event:=(origin->>'event_id')::uuid;
   if root_event is null then raise exception 'service_stale' using errcode='40001'; end if;
   continue;
 end if;
 exit;
 end loop;
 if boundary is not null or origin->>'kind'='continuation' then
   boundary:=coalesce(boundary,origin->'boundary');
   select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(boundary->>'conversation_id')::uuid;
   if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 elsif origin->>'kind'='command' then
   observed:=origin->'observed';
   if observed->>'organization_id' is distinct from p_org::text or observed->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if jsonb_typeof(observed->'destinations')='array' then
     sid:=coalesce(p_session,(observed->>'default_session_id')::uuid);
     select item->'observed' into observed from jsonb_array_elements(observed->'destinations') item where item->>'channel_session_id'=sid::text;
   else
     -- Compatibilidade com snapshot anterior: prova somente sua conversa, nunca ausência de outro canal.
     select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(observed->>'conversation_id')::uuid;
     if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
   end if;
 else raise exception 'service_stale' using errcode='40001'; end if;
 if sid is null then raise exception 'service_stale' using errcode='40001'; end if;
 if not exists(select 1 from public.channel_sessions where id=sid and organization_id=p_org and archived_at is null) then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 if boundary is null and observed is null then raise exception 'service_stale' using errcode='40001'; end if;
 select service_boundary into current_boundary from public.event_service_origins where organization_id=p_org and event_id=root_event and channel_session_id=sid;
 if found then boundary:=current_boundary;
 elsif boundary is null then
   -- PARA UM EVENTO, `absent` E PROCEDENCIA — NAO REIVINDICACAO DE ESTADO.
   --
   -- O CAS de `fn_service_begin` existe para que dois ATORES com a mesma
   -- observacao "ausente" nao ajam os dois: o segundo tem de perder, e o
   -- invariante de `fn_service_begin` guarda isso. Um evento e outra coisa: o
   -- retrato `absent` diz "quando este evento foi EMITIDO nao havia
   -- atendimento", e a resolucao de cada evento ja e idempotente pelo memo
   -- `event_service_origins` logo acima — nao ha corrida a arbitrar aqui.
   --
   -- Sem esta distincao o caminho ORDINARIO morria: um lead criado e depois
   -- movido de etapa gera DOIS eventos, cada um com seu retrato `absent`;
   -- resolver o primeiro cria a conversa e o segundo levantava 40001 — que
   -- `serviceForEvent` engole como `stale_origin`, entao o follow-up de etapa
   -- simplesmente nao nascia, sem erro em lugar nenhum.
   --
   -- Zerar `observed` so quando a conversa JA existe mantem o CAS de pe para o
   -- retrato que descreve uma fronteira concreta (esse continua sendo conferido
   -- contra a vigente) e para todo chamador direto de `fn_service_begin`.
   if observed->>'absent' = 'true' and exists(
        select 1 from public.conversations
         where organization_id=p_org and contact_id=p_contact
           and channel_session_id=sid and not is_group) then
     observed:=null;
   end if;
   boundary:=public.fn_service_begin(p_org,p_contact,sid,observed) - 'status' - 'demanda_fechada_em' - 'service_started_at';
 end if;
 if boundary->>'organization_id' is distinct from p_org::text or boundary->>'contact_id' is distinct from p_contact::text then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 cid:=(boundary->>'conversation_id')::uuid;
 if p_session is not null and not exists(select 1 from public.conversations where organization_id=p_org and id=cid and contact_id=p_contact and channel_session_id=p_session) then
   raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 current_boundary:=public.fn_service_boundary(p_org,cid);
 if current_boundary is null or current_boundary->>'status' in ('closed','resolved','archived')
   or current_boundary->>'demanda_fechada_em' is not null
   or (current_boundary - 'status' - 'demanda_fechada_em' - 'service_started_at') is distinct from boundary then
   raise exception 'service_stale' using errcode='40001'; end if;
 insert into public.event_service_origins(event_id,channel_session_id,organization_id,service_boundary) values(root_event,sid,p_org,boundary)
 on conflict(event_id,channel_session_id) do nothing;
 return boundary;
end; $function$;

notify pgrst, 'reload schema';
