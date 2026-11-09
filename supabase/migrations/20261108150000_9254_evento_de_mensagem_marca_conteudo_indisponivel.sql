-- 9254 · O evento de mensagem carrega a marca `conteudo_indisponivel`.
--
-- ─── Por que ────────────────────────────────────────────────────────────────
-- O WhatsApp oficial manda mensagens cujo conteúdo a Cloud API NÃO entrega
-- (`type: "unsupported"` — enquete, GIF, convite de grupo…) e tipos que o CRM
-- ainda não reconhece. Até aqui elas eram recusadas por `messages_type_check` e
-- se perdiam (183 entre 01 e 08/11/2026, medido na produção). Agora entram como
-- `text` com um RÓTULO do próprio CRM e `metadata.conteudo_indisponivel = true`
-- (`lib/channels/meta/tipos-da-meta.ts`).
--
-- Os handlers do `event_log` que RESPONDEM ao conteúdo (fluxos, automações, IA,
-- sentimento) decidem pelo payload do evento, e o payload só tinha colunas —
-- nenhum deles saberia que aquele texto é um rótulo. Responder a ele seria a IA
-- ou um fluxo conversando com uma frase que o cliente nunca escreveu.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- Só o payload, e só quando a marca existe: a chave `conteudo_indisponivel: true`
-- é acrescentada. Para TODA outra mensagem o payload sai byte a byte igual ao de
-- antes (o `||` com `'{}'`). O dispatcher (`lib/event-log/dispatcher.ts`) pula,
-- como `skipped`, os handlers que declaram `respondeAoConteudo`.
--
-- O corpo é o da ÚLTIMA definição do baseline, INTEIRO, mais a marca. A
-- comparação é `= 'true'` e não `::boolean`: um valor estranho em `metadata`
-- nunca pode derrubar o INSERT da mensagem.
--
-- `create or replace` preserva o ACL da função (nenhum grant muda) e o trigger
-- `trg_messages_emit_event` continua apontando para ela. Idempotente. Sem dado
-- reescrito, nenhuma linha histórica é tocada.

create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_event text;
begin
  if new.direction = 'inbound' then
    if exists (select 1 from public.conversations c
               where c.id = new.conversation_id and c.organization_id = new.organization_id and c.is_group) then
      v_event := 'message.group_received';
    else
      v_event := 'message.received';
    end if;
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
    || case when new.metadata->>'conteudo_indisponivel' = 'true'
            then jsonb_build_object('conteudo_indisponivel', true)
            else '{}'::jsonb
       end
  );
  return new;
end$$;
