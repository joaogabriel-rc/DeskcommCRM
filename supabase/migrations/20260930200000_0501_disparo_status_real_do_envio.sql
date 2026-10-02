-- 0501 — O status do disparo passa a refletir o RESULTADO do envio.
--
-- ── O defeito, medido ────────────────────────────────────────────────────────
--
-- Duas mensagens de um disparo com fluxo foram recusadas pela Meta: ficaram
-- `messages.status = 'failed'`, `error_code = 'meta_error'`, sem `external_id`.
-- Mesmo assim o disparo terminou `completed`, `sent_count = 2`,
-- `failed_count = 0`, e os destinatários ficaram `sent`.
--
-- A cadeia: `sendMessageHandler` NÃO lança quando o canal recusa — grava a linha
-- `failed` e a devolve. O nó de mensagem ignorava o retorno e avançava; a
-- execução terminava `completed`; o worker do disparo marcava o destinatário
-- `sent` porque a execução "não falhou"; e os contadores são contagem dos
-- status dos destinatários. O modo guiado tinha o mesmo defeito. E a recusa que
-- chega DEPOIS (webhook de status) só tocava `messages` — nada ligava a mensagem
-- ao destinatário.
--
-- ── O que muda ───────────────────────────────────────────────────────────────
--
--   1. `broadcast_recipients.status` ganha `in_flow`: o destinatário foi
--      processado (entrou no fluxo / o envio foi pedido) e AINDA NÃO HÁ desfecho
--      de envio. `sent` passa a significar "ao menos uma mensagem aceita pelo
--      canal e nenhuma recusada".
--   2. `messages.broadcast_recipient_id` liga a mensagem ao destinatário que a
--      originou (FK composta pela organização; apagar o destinatário não apaga
--      histórico — `on delete set null` só da coluna de ligação).
--   3. `fn_broadcast_recipient_reconcile` deriva o status do destinatário das
--      mensagens dele e da execução do fluxo; `fn_broadcast_recount` recalcula
--      os contadores do disparo e só o conclui quando não resta ninguém
--      `pending` nem `in_flow`.
--   4. Gatilhos em `messages` (insert / mudança de status) e em
--      `flow_executions` (mudança de status) chamam a reconciliação. Só SQL —
--      nenhum gatilho faz HTTP (doutrina). Com isso, a recusa que chega pelo
--      webhook minutos depois também corrige o disparo, qualquer que seja o
--      canal.
--   5. `broadcasts.in_flow_count`, para a tela mostrar quem está em andamento.
--
-- Sem backfill de status: disparos antigos não têm a ligação mensagem →
-- destinatário, e reclassificá-los seria adivinhar.

alter table public.broadcast_recipients drop constraint if exists broadcast_recipients_status_check;
alter table public.broadcast_recipients
  add constraint broadcast_recipients_status_check
  check (status in ('pending', 'in_flow', 'sent', 'failed', 'skipped'));

alter table public.broadcasts add column if not exists in_flow_count int not null default 0;

create unique index if not exists uq_broadcast_recipients_org_id
  on public.broadcast_recipients (organization_id, id);

create index if not exists idx_broadcast_recipients_broadcast_status
  on public.broadcast_recipients (broadcast_id, status);

alter table public.messages add column if not exists broadcast_recipient_id uuid;

do $$ begin
  alter table public.messages
    add constraint messages_broadcast_recipient_fk
    foreign key (organization_id, broadcast_recipient_id)
    references public.broadcast_recipients (organization_id, id)
    on delete set null (broadcast_recipient_id);
exception when duplicate_object then null; end $$;

create index if not exists idx_messages_broadcast_recipient
  on public.messages (broadcast_recipient_id)
  where broadcast_recipient_id is not null;

comment on column public.messages.broadcast_recipient_id is
  'Destinatário de disparo que originou esta mensagem (0501). Preenchido só pelo worker do disparo e pelo motor de fluxo — nunca pelo corpo de uma requisição.';

-- ── Recontagem do disparo ─────────────────────────────────────────────────────
create or replace function public.fn_broadcast_recount(p_broadcast uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending int := 0;
  v_in_flow int := 0;
  v_sent int := 0;
  v_failed int := 0;
  v_skipped int := 0;
  v_status text;
begin
  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'in_flow'),
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status = 'skipped')
  into v_pending, v_in_flow, v_sent, v_failed, v_skipped
  from public.broadcast_recipients
  where broadcast_id = p_broadcast;

  update public.broadcasts b
     set sent_count = v_sent,
         failed_count = v_failed,
         skipped_count = v_skipped,
         in_flow_count = v_in_flow,
         -- Concluir é só de `running`, e só sem ninguém pendente nem em
         -- andamento. Cancelado, pausado e falho não são reabertos por contagem.
         status = case
           when b.status = 'running' and v_pending = 0 and v_in_flow = 0 then 'completed'
           else b.status
         end,
         finished_at = case
           when b.status = 'running' and v_pending = 0 and v_in_flow = 0 then coalesce(b.finished_at, now())
           else b.finished_at
         end,
         updated_at = now()
   where b.id = p_broadcast
  returning b.status into v_status;

  return jsonb_build_object(
    'status', v_status,
    'pending', v_pending,
    'in_flow', v_in_flow,
    'sent', v_sent,
    'failed', v_failed,
    'skipped', v_skipped
  );
end;
$$;

revoke execute on function public.fn_broadcast_recount(uuid) from public, anon, authenticated;
grant execute on function public.fn_broadcast_recount(uuid) to service_role;

-- ── Reconciliação do destinatário ─────────────────────────────────────────────
create or replace function public.fn_broadcast_recipient_reconcile(p_recipient uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.broadcast_recipients%rowtype;
  v_total int := 0;
  v_recusada boolean := false;
  v_aceita boolean := false;
  v_primeiro_envio timestamptz;
  v_erro_msg text;
  v_exec_status text;
  v_exec_erro text;
  v_tem_exec boolean := false;
  v_novo text;
  v_erro text;
begin
  select * into r from public.broadcast_recipients where id = p_recipient;
  if not found then return null; end if;
  -- `pending` ainda não foi processado; `skipped` é desfecho de guarda local.
  if r.status not in ('in_flow', 'sent', 'failed') then return r.status; end if;

  select count(*),
         coalesce(bool_or(m.status = 'failed'), false),
         coalesce(bool_or(m.status in ('sent', 'delivered', 'read')), false),
         min(m.sent_at) filter (where m.status in ('sent', 'delivered', 'read'))
    into v_total, v_recusada, v_aceita, v_primeiro_envio
    from public.messages m
   where m.organization_id = r.organization_id
     and m.broadcast_recipient_id = r.id;

  if v_recusada then
    select left(concat_ws(': ', m.error_code, m.error_message), 300) into v_erro_msg
      from public.messages m
     where m.organization_id = r.organization_id
       and m.broadcast_recipient_id = r.id
       and m.status = 'failed'
     order by m.updated_at desc nulls last
     limit 1;
  end if;

  select e.status, e.last_error into v_exec_status, v_exec_erro
    from public.flow_executions e
   where e.organization_id = r.organization_id
     and e.broadcast_recipient_id = r.id
   limit 1;
  v_tem_exec := found;

  if v_recusada then
    v_novo := 'failed';
    v_erro := coalesce(nullif(v_erro_msg, ''), 'envio_recusado');
  elsif v_aceita then
    v_novo := 'sent';
    v_erro := null;
  elsif v_tem_exec and v_exec_status = 'failed' then
    v_novo := 'failed';
    v_erro := left(coalesce(v_exec_erro, 'flow_failed'), 300);
  elsif v_tem_exec and v_exec_status = 'completed' and v_total = 0 then
    v_novo := 'skipped';
    v_erro := 'fluxo_concluido_sem_envio';
  elsif v_tem_exec and v_exec_status = 'cancelled' and v_total = 0 then
    v_novo := 'skipped';
    v_erro := 'fluxo_cancelado';
  elsif v_total > 0 or v_tem_exec then
    v_novo := 'in_flow';
    v_erro := null;
  else
    -- Nada que diga o contrário: o desfecho gravado pelo worker (ex.: falha antes
    -- de pedir o envio) continua valendo.
    return r.status;
  end if;

  if v_novo is distinct from r.status or v_erro is distinct from r.error then
    update public.broadcast_recipients
       set status = v_novo,
           error = v_erro,
           sent_at = case when v_novo = 'sent' then coalesce(v_primeiro_envio, r.sent_at, now()) else r.sent_at end,
           updated_at = now()
     where id = r.id;
    perform public.fn_broadcast_recount(r.broadcast_id);
  end if;

  return v_novo;
end;
$$;

revoke execute on function public.fn_broadcast_recipient_reconcile(uuid) from public, anon, authenticated;
grant execute on function public.fn_broadcast_recipient_reconcile(uuid) to service_role;

-- ── Gatilhos: a mensagem e a execução avisam o destinatário ───────────────────
create or replace function public.fn_trg_broadcast_recipient_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fn_broadcast_recipient_reconcile(new.broadcast_recipient_id);
  return null;
end;
$$;

revoke execute on function public.fn_trg_broadcast_recipient_from_message() from public, anon, authenticated;

create or replace function public.fn_trg_broadcast_recipient_from_execution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fn_broadcast_recipient_reconcile(new.broadcast_recipient_id);
  return null;
end;
$$;

revoke execute on function public.fn_trg_broadcast_recipient_from_execution() from public, anon, authenticated;

drop trigger if exists trg_messages_broadcast_recipient_ins on public.messages;
create trigger trg_messages_broadcast_recipient_ins
  after insert on public.messages
  for each row
  when (new.broadcast_recipient_id is not null)
  execute function public.fn_trg_broadcast_recipient_from_message();

drop trigger if exists trg_messages_broadcast_recipient_upd on public.messages;
create trigger trg_messages_broadcast_recipient_upd
  after update of status on public.messages
  for each row
  when (new.broadcast_recipient_id is not null and old.status is distinct from new.status)
  execute function public.fn_trg_broadcast_recipient_from_message();

drop trigger if exists trg_flow_executions_broadcast_recipient on public.flow_executions;
create trigger trg_flow_executions_broadcast_recipient
  after update of status on public.flow_executions
  for each row
  when (new.broadcast_recipient_id is not null and old.status is distinct from new.status)
  execute function public.fn_trg_broadcast_recipient_from_execution();
