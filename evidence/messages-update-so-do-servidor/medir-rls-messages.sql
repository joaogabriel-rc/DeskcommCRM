-- Medição SÓ no banco de prova local. Tudo dentro de uma transação que termina em ROLLBACK.
\pset pager off
\set ON_ERROR_STOP on
begin;
-- um usuário VIEWER (o menor papel) na mesma organização da prova
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer.medicao@prova-visual.test', '', now(), now(), now(), '{}', '{}');
insert into public.user_organizations (user_id, organization_id, role, accepted_at)
values ('00000000-0000-4000-8000-0000000000aa', '3c09c143-85bc-477b-a45c-806727f3568c', 'viewer', now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select 'auth.uid()' as o_que, auth.uid()::text as valor;

-- 1. viewer reescreve o corpo de uma recebida viva
with u as (update public.messages set body = 'ADULTERADO PELO VIEWER' where external_id = 'wamid.apg1.viva' returning id)
select '1 viewer reescreve body de recebida' caso, count(*) linhas from u;
-- 2. viewer DESFAZ o apagamento e devolve conteúdo à recebida apagada pelo contato
with u as (update public.messages set revoked_at = null, body = 'CONTEÚDO RESTAURADO', metadata = '{}'::jsonb where external_id = 'wamid.apg1.txt' returning id)
select '2 viewer desfaz revoked_at e restaura body' caso, count(*) linhas from u;
-- 3. viewer muda status/autoria de mensagem enviada (falsifica entrega e autor)
with u as (update public.messages set status = 'read', sent_by_user_id = '00000000-0000-4000-8000-0000000000aa' where external_id = 'wamid.apg1.eco' returning id)
select '3 viewer falsifica status e autor de enviada' caso, count(*) linhas from u;
-- 4. viewer move mensagem para outra conversa da mesma organização
with u as (update public.messages set conversation_id = conversation_id where external_id = 'wamid.apg1.viva' returning id)
select '4 viewer pode trocar conversation_id (mesma org)' caso, count(*) linhas from u;
-- 5. viewer tenta mover a mensagem para OUTRA organização (WITH CHECK)
savepoint s5;
do $$ begin
  update public.messages set organization_id = gen_random_uuid() where external_id = 'wamid.apg1.viva';
  raise notice '5 mover para outra org: ACEITO (defeito)';
exception when others then raise notice '5 mover para outra org: recusado (%)', sqlstate;
end $$;
rollback to savepoint s5;
-- 6. viewer INSERE mensagens forjadas (recebida e enviada)
savepoint s6;
do $$ begin
  insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, type, status, body, sent_at)
  select organization_id, conversation_id, channel_session_id, contact_id, 'inbound', 'text', 'received', 'RECEBIDA FORJADA', now()
  from public.messages where external_id = 'wamid.apg1.viva';
  raise notice '6a recebida forjada: ACEITA';
exception when others then raise notice '6a recebida forjada: recusada (% %)', sqlstate, sqlerrm;
end $$;
rollback to savepoint s6;
savepoint s6b;
do $$ begin
  insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, type, status, body, sent_at, sent_via)
  select organization_id, conversation_id, channel_session_id, contact_id, 'outbound', 'text', 'read', 'ENVIADA FORJADA (nunca saiu)', now(), 'crm'
  from public.messages where external_id = 'wamid.apg1.viva';
  raise notice '6b enviada forjada: ACEITA';
exception when others then raise notice '6b enviada forjada: recusada (% %)', sqlstate, sqlerrm;
end $$;
rollback to savepoint s6b;
-- 7. viewer APAGA mensagens da conversa
with d as (delete from public.messages where external_id = 'wamid.apg1.eco' returning id)
select '7 viewer apaga mensagem' caso, count(*) linhas from d;

reset role;
-- 8. anon (chave pública que vai para o navegador)
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
with u as (update public.messages set body = 'ANON' returning id)
select '8 anon atualiza qualquer mensagem' caso, count(*) linhas from u;
reset role;
rollback;
