-- 0508 · Um fluxo só se LIGA a um disparo em rascunho.
--
-- ─── O buraco que a 0507 deixou ─────────────────────────────────────────────
-- A 0507 protege o fluxo que JÁ É de um disparo: `fn_trg_flow_definicao_protegida`
-- sai cedo quando `old.broadcast_id is null`, e não há gatilho no INSERT. Pela
-- REST direta (a policy `flows_manager_write` é `for all`), um gestor podia:
--   * criar um fluxo com `broadcast_id` de um disparo GUIADO já agendado, em
--     andamento ou concluído; ou
--   * trocar o `broadcast_id` de um fluxo de Automações de NULL para esse disparo.
-- O worker dos disparos lê o fluxo do disparo a cada tique
-- (`lib/disparos/worker.ts`): quem ainda não tinha recebido passaria por um
-- fluxo que ninguém agendou; e o disparo concluído passaria a se apresentar como
-- "modo fluxo", reescrevendo o próprio histórico.
--
-- ─── A regra ────────────────────────────────────────────────────────────────
-- Quando o vínculo NASCE ou MUDA (insert com `broadcast_id`, ou update que troca
-- `broadcast_id`/`organization_id`), o disparo tem de estar em `draft` — o único
-- estado em que o produto cria o fluxo do disparo (`criarFluxoDoDisparo`, troca
-- de modo só em rascunho) e em que a duplicação (0507) o cria. Ser da MESMA
-- organização continua garantido pela FK composta `flows_broadcast_org_fk`
-- (0399), que recusa o vínculo cruzado com o erro de sempre. `broadcast_id`
-- NULL não é tocado: Automações seguem iguais.
-- Trocar de um disparo para OUTRO cai nas duas guardas: a 0507 exige o fluxo de
-- origem editável, esta exige o disparo de destino em rascunho.
--
-- `for share` na linha do disparo, como na 0507: um agendamento concorrente
-- (que faz `update` nela) espera o vínculo terminar, ou o vínculo espera e vê o
-- status novo. Gatilho, não rota: vale para RPC, REST direta e `service_role`.
--
-- Erro `PT409` `flow_vinculo_invalido:<motivo>`. Sem dado reescrito: um vínculo
-- que já exista não é reavaliado (o gatilho só olha o momento em que ele nasce).
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

create or replace function public.fn_trg_flow_vinculo_ao_disparo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if new.broadcast_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.broadcast_id is not distinct from old.broadcast_id
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;

  select b.status into v_status
    from public.broadcasts b
   where b.id = new.broadcast_id
     and b.organization_id = new.organization_id
     for share;
  -- Disparo inexistente ou de OUTRA organização: quem recusa é a FK composta
  -- `flows_broadcast_org_fk` (0399), com o erro de sempre — esta regra é sobre
  -- o ESTADO do disparo, o isolamento já era garantido pela estrutura.
  if not found then
    return new;
  end if;
  if v_status <> 'draft' then
    raise exception 'flow_vinculo_invalido:%', v_status
      using errcode = 'PT409',
            hint = 'O fluxo só pode ser ligado a um disparo em rascunho.';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_trg_flow_vinculo_ao_disparo() from public, anon, authenticated, service_role;

drop trigger if exists trg_flows_vinculo_ao_disparo on public.flows;
create trigger trg_flows_vinculo_ao_disparo
  before insert or update of broadcast_id, organization_id on public.flows
  for each row execute function public.fn_trg_flow_vinculo_ao_disparo();
