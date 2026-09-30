-- ---- a lista de registro perde os três tipos que ganharam consumidor (migration 0492) ----
--
-- Forward-fix de uma corrida entre duas migrations que reescreveram a MESMA
-- função, `fn_event_log_e_registro`, partindo de listas diferentes:
--
--   · a 0388 (Flow Builder) tirou `contact.created` e `contact.updated` — eles
--     viraram gatilho do construtor de fluxos ("Novo contato criado" e "Valor
--     de um campo do contato mudou");
--   · a 0417 (#1614) tirou `message.failed` — ele virou gatilho de automação —,
--     mas reescreveu a lista a partir da versão da 0239, e por isso DEVOLVEU os
--     dois `contact.*`.
--
-- `create or replace` com a mesma assinatura sobrescreve: em ordem de
-- aplicação, a 0417 roda depois da 0388, então quem atualiza pela cadeia ficava
-- com os gatilhos de contato do Flow Builder mortos. No `baseline.sql` era o
-- inverso: o bloco da 0388 é a última definição, e ali `message.failed`
-- continuava na lista. Cada público recebia um defeito diferente, e os dois
-- têm o mesmo modo de falha mudo que a 0239 combate:
-- `fn_event_log_marca_registro` (BEFORE INSERT) troca `pending` por `done`
-- para todo tipo da lista, o drain (`status='pending'` AND
-- `event_type in (handlers)`) nunca o seleciona, e o handler registrado nunca
-- roda — a regra aparece na tela, o operador salva, o evento acontece e nada
-- acontece.
--
-- Esta função é a UNIÃO das duas remoções: a lista da 0239 sem os três tipos.
-- Os demais ficam como estão.
--
-- Gates: `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` (tipo com
-- consumidor NÃO pode estar na lista, lida no baseline E na cadeia) e
-- `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts` (o corpo do
-- apêndice é o mesmo da última definição na cadeia).
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
    -- (`contact.created` e `contact.updated` saíram na 0388: gatilhos do Flow Builder)
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
    -- mensagem (`message.failed` saiu na 0417: gatilho de automação)
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

-- Mesma ACL da 0239 (create or replace preserva os grants; repetir não custa
-- nada e deixa o arquivo autocontido para quem lê só esta migration).
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- Backfill? NENHUM, e de propósito (mesmo critério da 0417): as linhas que já
-- nasceram `done` como registro continuam legíveis como estão. Voltá-las para
-- `pending` faria o motor reprocessar evento velho — fluxo ou regra rodando
-- hoje por um contato criado ou uma falha de entrega de dias atrás, com o
-- estado do contato de agora.

notify pgrst, 'reload schema';
