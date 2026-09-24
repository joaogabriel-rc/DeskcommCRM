-- 0399 · O disparo pode levar o público por um FLUXO — o mesmo motor das automações.
--
-- ─── O desenho em uma frase ─────────────────────────────────────────────────
-- Um disparo "modo fluxo" tem UM fluxo próprio (gatilho `broadcast`), o worker
-- dos disparos inicia uma execução desse fluxo por destinatário, e a execução
-- CARREGA a permissão de envio que o disparo já materializou no clique de
-- "Agendar" (`broadcast_recipients.service_boundary`, migration 0389). O nó de
-- mensagem reconfere essa permissão — nenhuma autorização nova nasce no worker.
--
-- ─── Por que `flows.broadcast_id`, e não `broadcasts.flow_id` ───────────────
-- A pergunta que o banco precisa responder é "este fluxo é de um disparo, e de
-- qual?" — e com a coluna no FLUXO ela vira regra de UMA tabela:
--   * `flows_disparo_coerente`: gatilho `broadcast` ⇔ `broadcast_id` preenchido.
--     Um fluxo de Automações nunca vira fluxo de disparo, e um fluxo de disparo
--     nunca escuta evento — o que `broadcasts.flow_id` não conseguiria garantir
--     sem trigger (o CHECK não enxerga a outra tabela);
--   * `uq_flows_broadcast`: um fluxo por disparo;
--   * FK COMPOSTA `(organization_id, broadcast_id)` → broadcasts: o disparo e o
--     fluxo são da mesma organização, por construção;
--   * `on delete cascade`: apagar o disparo (só possível antes de enviar) leva o
--     fluxo dele junto, em vez de deixar um fluxo órfão.
--
-- ─── A execução iniciada pelo disparo ───────────────────────────────────────
-- `flow_executions.service_boundary` guarda a permissão materializada, e
-- `broadcast_recipient_id` diz de qual destinatário ela veio:
--   * `uq_flow_executions_recipient`: um destinatário inicia NO MÁXIMO uma
--     execução, mesmo que o lease do worker vença no meio do lote;
--   * `fn_flow_execution_do_disparo_coerente` (trigger, sem HTTP): o
--     destinatário é da mesma organização, do disparo DONO do fluxo, do mesmo
--     contato; e a permissão é da mesma organização e do mesmo contato.
--
-- ─── A materialização passa a respeitar o NÚMERO ────────────────────────────
-- `fn_broadcast_materializar` ganha `p_session`: o modelo aprovado é da conta
-- de um número, e a permissão tem de ser aberta NA conversa desse número — sem
-- isso, `fn_service_begin` escolhia o número padrão do contato e o envio do
-- modelo falhava depois, com o contato já no fluxo. O número tem de ser da
-- organização e estar ativo. A assinatura antiga é derrubada (senão o
-- PostgREST resolveria a chamada na sobrecarga velha — a lição da 0336).
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

-- ═══ 1. O fluxo do disparo ═══════════════════════════════════════════════════

alter table public.flows add column if not exists broadcast_id uuid;

create unique index if not exists uq_broadcasts_org_id on public.broadcasts (organization_id, id);

do $$ begin
  alter table public.flows
    add constraint flows_broadcast_org_fk
    foreign key (organization_id, broadcast_id)
    references public.broadcasts (organization_id, id)
    on delete cascade;
exception when duplicate_object then null; end $$;

create unique index if not exists uq_flows_broadcast
  on public.flows (broadcast_id)
  where broadcast_id is not null;

-- O vocabulário do gatilho ganha `broadcast`. Mesmo conjunto de antes + um.
alter table public.flows drop constraint if exists flows_trigger_type_check;
alter table public.flows
  add constraint flows_trigger_type_check check (
    trigger_type in (
      'contact_created', 'contact_tag_added', 'contact_tag_removed', 'contact_field_changed',
      'contact_birthday', 'whatsapp_message_received',
      'lead_created', 'lead_stage_changed', 'lead_won', 'lead_lost',
      'appointment_created', 'appointment_confirmed', 'appointment_cancelled',
      'broadcast'
    )
  );

-- Nenhuma linha anterior viola: `broadcast_id` acabou de nascer nulo e
-- `broadcast` acabou de entrar no vocabulário.
do $$ begin
  alter table public.flows
    add constraint flows_disparo_coerente
    check ((trigger_type is not distinct from 'broadcast') = (broadcast_id is not null));
exception when duplicate_object then null; end $$;

comment on column public.flows.broadcast_id is
  'Disparo DONO deste fluxo (migration 0399). Preenchido ⇔ trigger_type = broadcast. Fluxo de disparo não aparece em Automações e só liga pelo agendamento do disparo.';

-- ═══ 2. A execução iniciada pelo disparo ═════════════════════════════════════

alter table public.flow_executions add column if not exists service_boundary jsonb;
alter table public.flow_executions add column if not exists broadcast_recipient_id uuid;

create unique index if not exists uq_broadcast_recipients_org_id
  on public.broadcast_recipients (organization_id, id);

do $$ begin
  alter table public.flow_executions
    add constraint flow_executions_recipient_org_fk
    foreign key (organization_id, broadcast_recipient_id)
    references public.broadcast_recipients (organization_id, id)
    on delete cascade;
exception when duplicate_object then null; end $$;

create unique index if not exists uq_flow_executions_recipient
  on public.flow_executions (broadcast_recipient_id)
  where broadcast_recipient_id is not null;

do $$ begin
  alter table public.flow_executions
    add constraint flow_executions_disparo_tem_permissao
    check (broadcast_recipient_id is null or jsonb_typeof(service_boundary) = 'object');
exception when duplicate_object then null; end $$;

comment on column public.flow_executions.service_boundary is
  'Permissão de envio materializada pelo DISPARO no agendamento (broadcast_recipients.service_boundary), carregada até o nó de mensagem, que a reconfere (assertServiceBoundarySupabase). Nula nas execuções iniciadas por evento (migration 0399).';

create or replace function public.fn_flow_execution_do_disparo_coerente() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  if new.broadcast_recipient_id is null then
    return new;
  end if;
  -- O destinatário é da organização da execução, do disparo DONO do fluxo e do
  -- mesmo contato. Qualquer divergência é tentativa de usar a permissão de um
  -- disparo noutro lugar — recusa.
  if not exists (
    select 1
      from public.broadcast_recipients r
      join public.flows f
        on f.id = new.flow_id
       and f.organization_id = new.organization_id
       and f.broadcast_id = r.broadcast_id
     where r.id = new.broadcast_recipient_id
       and r.organization_id = new.organization_id
       and r.contact_id = new.contact_id
  ) then
    raise exception 'flow_execution_disparo_incoerente' using errcode = '23514';
  end if;
  if new.service_boundary->>'organization_id' is distinct from new.organization_id::text
     or new.service_boundary->>'contact_id' is distinct from new.contact_id::text then
    raise exception 'flow_execution_permissao_de_outro_escopo' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_flow_execution_do_disparo_coerente() from public;
revoke execute on function public.fn_flow_execution_do_disparo_coerente() from anon;
revoke execute on function public.fn_flow_execution_do_disparo_coerente() from authenticated;

drop trigger if exists trg_flow_execution_do_disparo_coerente on public.flow_executions;
create trigger trg_flow_execution_do_disparo_coerente
  before insert or update of broadcast_recipient_id, service_boundary, flow_id, contact_id, organization_id
  on public.flow_executions
  for each row execute function public.fn_flow_execution_do_disparo_coerente();

-- ═══ 3. A materialização abre a permissão NO número do disparo ═══════════════

drop function if exists public.fn_broadcast_materializar(uuid, uuid, uuid[]);
create or replace function public.fn_broadcast_materializar(
  p_broadcast uuid,
  p_org uuid,
  p_contact_ids uuid[],
  p_session uuid default null
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
  -- O número vem do disparo (e do fluxo dele); ainda assim é conferido AQUI,
  -- dentro do definer: número de outra organização ou arquivado não abre
  -- permissão nenhuma.
  if p_session is not null and not exists (
    select 1 from public.channel_sessions
     where id = p_session and organization_id = p_org and archived_at is null
  ) then
    raise exception 'broadcast_session_not_in_organization' using errcode = 'P0002';
  end if;

  foreach v_contact in array coalesce(p_contact_ids, array[]::uuid[])
  loop
    begin
      -- `p_observed => null` pula o CAS de `fn_service_begin` de propósito: o
      -- CAS existe para arbitrar dois ATORES com a mesma observação "ausente",
      -- e aqui há um ator só, o operador que clicou.
      v_boundary := public.fn_service_begin(p_org, v_contact, p_session);
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

revoke all on function public.fn_broadcast_materializar(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.fn_broadcast_materializar(uuid, uuid, uuid[], uuid) to service_role;

notify pgrst, 'reload schema';
