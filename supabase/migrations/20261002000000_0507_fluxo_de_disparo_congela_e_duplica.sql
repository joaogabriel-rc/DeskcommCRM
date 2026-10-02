-- 0507 · O fluxo de um disparo CONGELA quando é usado, e o disparo se DUPLICA.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- O fluxo de um disparo (0399) aponta para a definição VIVA: `fn_flow_replace_graph`
-- apaga e reinsere `flow_nodes`/`flow_edges` a cada salvamento, e não há versão.
-- Como as referências do histórico são `on delete set null`
-- (`flow_execution_events.node_id`, `flow_executions.current_node_id`,
-- `waiting_node_id`, `listening_node_id`), reescrever um grafo já usado anula o
-- rastro de TODA execução — inclusive dos nós que voltam com o mesmo id, porque
-- a ação da FK roda no `delete`, antes do `insert` — e a execução viva perde o
-- nó em que estava. A única trava era `flows.status = 'active'` na ROTA; a RLS
-- de `flow_nodes`/`flow_edges`/`flows` deixa o gestor escrever direto pela REST,
-- e `fn_flow_replace_graph` é chamável como RPC. O `DELETE` do disparo só recusava
-- com `sent_count > 0`: um disparo cujas mensagens FALHARAM, com execuções, era
-- apagável — e a cascata levava fluxo, execuções e eventos.
--
-- ─── A regra (uma só, aqui) ─────────────────────────────────────────────────
-- `fn_flow_estado_de_edicao_interno(fluxo)` devolve, para fluxo de DISPARO:
--   * `historico` — disparo `completed`/`cancelled`/`failed`; ou qualquer outro
--     estado com execução já existente e nenhuma viva (a definição foi usada);
--   * `em_uso`    — disparo `scheduled`/`running`; ou execução viva;
--   * `editavel`  — disparo `draft`/`paused` sem execução nenhuma.
-- Execução viva = `running`/`waiting`, ou botão ainda clicável
-- (`listening_until > now()` em `waiting`/`completed` — a mesma condição com que
-- `lib/flows/reply.handler.ts` reabre a execução). Fluxo de AUTOMAÇÕES fica fora
-- (`escopo = 'automacao'`): esta entrega não muda o comportamento dele.
--
-- ─── Onde a regra vale ──────────────────────────────────────────────────────
-- Em GATILHO, para cobrir todo caminho que escreve — rota, RPC
-- `fn_flow_replace_graph`, REST direta, `service_role`:
--   * `flow_nodes`/`flow_edges`: insert, update, delete;
--   * `flows`: update de gatilho, dono, organização ou status, e delete;
--   * `broadcasts`: delete de disparo com destinatário processado ou execução.
-- A trava faz `for share` na linha do disparo: agendar, retomar e pausar
-- (`update` nela) esperam o salvamento terminar, ou o salvamento espera e vê o
-- status novo. Execução nova só nasce com o disparo `running`, que a trava exclui.
--
-- ─── A cascata legítima ─────────────────────────────────────────────────────
-- Quem está ACIMA já decidiu: se a organização não existe mais (exclusão da
-- empresa) ou se o pai imediato não existe mais (o fluxo, para o grafo; o
-- disparo, para o fluxo), a linha sai sem pergunta. Um pai só sai pela própria
-- guarda, então a exceção não abre caminho novo.
--
-- ─── Duplicar ───────────────────────────────────────────────────────────────
-- `fn_broadcast_duplicar` cria um disparo `draft` e um fluxo próprio com nós,
-- configurações, posições e arestas, ids de nó remapeados. Nenhuma `config`
-- guarda id de nó (conferido no código e nos dados); o id do FLUXO aparece na
-- pasta da imagem (`<org>/flows/<fluxo>/…`) e em `start_flow`/`stop_flow` que
-- apontem para o próprio fluxo, e é trocado pelo novo. Os arquivos da imagem são
-- copiados pela rota, que tem o Storage. Não copia execução, evento,
-- destinatário, mensagem nem contador. `security invoker`: vale a RLS de quem
-- chama (só `manager` escreve nas quatro tabelas).
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

-- ═══ 1. "Este fluxo já foi usado?" precisa de índice ════════════════════════

create index if not exists idx_flow_executions_flow on public.flow_executions (flow_id);

-- ═══ 2. O estado de edição ══════════════════════════════════════════════════

create or replace function public.fn_flow_estado_de_edicao_interno(p_flow uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_disparo uuid;
  v_status text;
  v_vivas integer;
  v_usado boolean;
  v_estado text;
begin
  select f.organization_id, f.broadcast_id into v_org, v_disparo
    from public.flows f
   where f.id = p_flow;
  if not found then
    return null;
  end if;
  if v_disparo is null then
    return jsonb_build_object('escopo', 'automacao', 'estado', null, 'vivas', 0, 'usado', false, 'disparo_status', null);
  end if;

  select b.status into v_status
    from public.broadcasts b
   where b.id = v_disparo and b.organization_id = v_org;

  select count(*) filter (
           where e.status in ('running', 'waiting')
              or (e.listening_node_id is not null
                  and e.listening_until > now()
                  and e.status in ('waiting', 'completed'))),
         count(*) > 0
    into v_vivas, v_usado
    from public.flow_executions e
   where e.flow_id = p_flow and e.organization_id = v_org;

  v_estado := case
    when v_status is null then 'historico'
    when v_status in ('completed', 'cancelled', 'failed') then 'historico'
    when v_status in ('scheduled', 'running') then 'em_uso'
    when v_vivas > 0 then 'em_uso'
    when v_usado then 'historico'
    else 'editavel'
  end;

  return jsonb_build_object(
    'escopo', 'disparo',
    'estado', v_estado,
    'vivas', v_vivas,
    'usado', v_usado,
    'disparo_status', v_status
  );
end;
$$;

revoke all on function public.fn_flow_estado_de_edicao_interno(uuid) from public, anon, authenticated, service_role;

-- A face para a tela: a mesma resposta, só para quem é da organização do fluxo.
create or replace function public.fn_flow_estado_de_edicao(p_flow uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select f.organization_id into v_org from public.flows f where f.id = p_flow;
  if v_org is null then
    return null;
  end if;
  if auth.uid() is not null
     and not (v_org in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()) then
    return null;
  end if;
  return public.fn_flow_estado_de_edicao_interno(p_flow);
end;
$$;

revoke all on function public.fn_flow_estado_de_edicao(uuid) from public, anon;
grant execute on function public.fn_flow_estado_de_edicao(uuid) to authenticated, service_role;

-- ═══ 3. A trava ═════════════════════════════════════════════════════════════

create or replace function public.fn_flow_exigir_editavel(p_flow uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  perform 1
     from public.broadcasts b
     join public.flows f on f.broadcast_id = b.id
    where f.id = p_flow
      for share of b;
  v := public.fn_flow_estado_de_edicao_interno(p_flow);
  if v is not null and v ->> 'escopo' = 'disparo' and v ->> 'estado' <> 'editavel' then
    raise exception 'flow_protegido:%', v ->> 'estado'
      using errcode = 'PT409',
            hint = 'O fluxo deste disparo já foi usado ou está em uso. Duplique o disparo para editar uma cópia.';
  end if;
end;
$$;

revoke all on function public.fn_flow_exigir_editavel(uuid) from public, anon, authenticated, service_role;

-- ═══ 4. O grafo: flow_nodes e flow_edges ════════════════════════════════════

create or replace function public.fn_trg_flow_grafo_protegido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_flow uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_flow := old.flow_id;
  else
    v_org := new.organization_id;
    v_flow := new.flow_id;
  end if;

  -- A cascata de quem está acima já decidiu: a empresa saiu, ou o fluxo saiu
  -- pela própria guarda.
  if exists (select 1 from public.organizations o where o.id = v_org)
     and exists (select 1 from public.flows f where f.id = v_flow) then
    perform public.fn_flow_exigir_editavel(v_flow);
  end if;

  if tg_op = 'UPDATE' and old.flow_id is distinct from new.flow_id
     and exists (select 1 from public.flows f where f.id = old.flow_id) then
    perform public.fn_flow_exigir_editavel(old.flow_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.fn_trg_flow_grafo_protegido() from public, anon, authenticated, service_role;

drop trigger if exists trg_flow_nodes_protegido on public.flow_nodes;
create trigger trg_flow_nodes_protegido
  before insert or update or delete on public.flow_nodes
  for each row execute function public.fn_trg_flow_grafo_protegido();

drop trigger if exists trg_flow_edges_protegido on public.flow_edges;
create trigger trg_flow_edges_protegido
  before insert or update or delete on public.flow_edges
  for each row execute function public.fn_trg_flow_grafo_protegido();

-- ═══ 5. A definição: flows ══════════════════════════════════════════════════

create or replace function public.fn_trg_flow_definicao_protegida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.broadcast_id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if exists (select 1 from public.organizations o where o.id = old.organization_id)
       and exists (select 1 from public.broadcasts b where b.id = old.broadcast_id) then
      perform public.fn_flow_exigir_editavel(old.id);
    end if;
    return old;
  end if;

  -- Nome, descrição, versão e `updated_at` não mudam o que o contato percorre.
  if (new.trigger_type, new.trigger_config, new.broadcast_id, new.organization_id, new.status)
     is distinct from
     (old.trigger_type, old.trigger_config, old.broadcast_id, old.organization_id, old.status) then
    perform public.fn_flow_exigir_editavel(old.id);
  end if;
  return new;
end;
$$;

revoke all on function public.fn_trg_flow_definicao_protegida() from public, anon, authenticated, service_role;

drop trigger if exists trg_flows_definicao_protegida on public.flows;
create trigger trg_flows_definicao_protegida
  before update or delete on public.flows
  for each row execute function public.fn_trg_flow_definicao_protegida();

-- ═══ 6. O disparo que já tocou alguém não se apaga ══════════════════════════

create or replace function public.fn_trg_broadcast_historico_protegido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;
  if exists (select 1 from public.broadcast_recipients r
              where r.broadcast_id = old.id and r.status <> 'pending')
     or exists (select 1 from public.flow_executions e
                  join public.flows f on f.id = e.flow_id
                 where f.broadcast_id = old.id)
     or exists (select 1 from public.flow_executions e
                  join public.broadcast_recipients r on r.id = e.broadcast_recipient_id
                 where r.broadcast_id = old.id) then
    raise exception 'disparo_com_historico'
      using errcode = 'PT409',
            hint = 'Este disparo já processou destinatários: o registro de quem recebeu o quê é histórico. Cancele-o.';
  end if;
  return old;
end;
$$;

revoke all on function public.fn_trg_broadcast_historico_protegido() from public, anon, authenticated, service_role;

drop trigger if exists trg_broadcasts_historico_protegido on public.broadcasts;
create trigger trg_broadcasts_historico_protegido
  before delete on public.broadcasts
  for each row execute function public.fn_trg_broadcast_historico_protegido();

-- ═══ 7. Duplicar o disparo ══════════════════════════════════════════════════

create or replace function public.fn_broadcast_duplicar(p_broadcast uuid, p_organization_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_origem public.broadcasts%rowtype;
  v_fluxo_origem public.flows%rowtype;
  v_novo uuid := gen_random_uuid();
  v_fluxo_novo uuid;
  v_nome text;
  v_mapa jsonb;
begin
  select * into v_origem
    from public.broadcasts b
   where b.id = p_broadcast and b.organization_id = p_organization_id;
  if not found then
    raise exception 'broadcast_not_found_in_organization' using errcode = 'P0002';
  end if;

  v_nome := left(v_origem.name, 120 - length(' (cópia)')) || ' (cópia)';

  insert into public.broadcasts (id, organization_id, name, status, segment, message, created_by_user_id)
  values (v_novo, p_organization_id, v_nome, 'draft', v_origem.segment, v_origem.message, auth.uid());

  select * into v_fluxo_origem
    from public.flows f
   where f.organization_id = p_organization_id and f.broadcast_id = p_broadcast;

  if found then
    v_fluxo_novo := gen_random_uuid();

    insert into public.flows (id, organization_id, name, description, status, trigger_type, trigger_config,
                              version, created_by_user_id, broadcast_id)
    values (v_fluxo_novo, p_organization_id, left('Disparo: ' || v_nome, 120), v_fluxo_origem.description,
            'draft', v_fluxo_origem.trigger_type, v_fluxo_origem.trigger_config, 1, auth.uid(), v_novo);

    select coalesce(jsonb_object_agg(n.id::text, gen_random_uuid()), '{}'::jsonb) into v_mapa
      from public.flow_nodes n
     where n.flow_id = v_fluxo_origem.id and n.organization_id = p_organization_id;

    insert into public.flow_nodes (id, organization_id, flow_id, type, label, config, position_x, position_y)
    select (v_mapa ->> n.id::text)::uuid, p_organization_id, v_fluxo_novo, n.type, n.label,
           replace(n.config::text, v_fluxo_origem.id::text, v_fluxo_novo::text)::jsonb,
           n.position_x, n.position_y
      from public.flow_nodes n
     where n.flow_id = v_fluxo_origem.id and n.organization_id = p_organization_id;

    insert into public.flow_edges (id, organization_id, flow_id, source_node_id, target_node_id, source_handle)
    select gen_random_uuid(), p_organization_id, v_fluxo_novo,
           (v_mapa ->> e.source_node_id::text)::uuid, (v_mapa ->> e.target_node_id::text)::uuid,
           e.source_handle
      from public.flow_edges e
     where e.flow_id = v_fluxo_origem.id and e.organization_id = p_organization_id;
  end if;

  return jsonb_build_object(
    'broadcast_id', v_novo,
    'flow_id', v_fluxo_novo,
    'flow_id_origem', v_fluxo_origem.id
  );
end;
$$;

revoke all on function public.fn_broadcast_duplicar(uuid, uuid) from public, anon;
grant execute on function public.fn_broadcast_duplicar(uuid, uuid) to authenticated, service_role;
