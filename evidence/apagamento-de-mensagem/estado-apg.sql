\pset pager off
select external_id, direction, type, revoked_at is not null as apagada, left(body,45) body, media_url is not null tem_url, media_storage_path, (metadata::text ~ 'SEGREDO') meta_tem_segredo, metadata->'apagamento' apagamento from messages where external_id like 'wamid.apg1.%' order by sent_at;
select left(c.last_message_preview,50) previa from conversations c where c.id in (select conversation_id from messages where external_id like 'wamid.apg1.%');
select count(*) filter (where payload::text ~ 'SEGREDO|EMPRESA-APAGOU') eventos_com_texto, count(*) eventos from event_log where payload->>'message_id' in (select id::text from messages where external_id like 'wamid.apg1.%');
select count(*) filter (where raw_body ~ 'SEGREDO') arquivos_com_segredo, count(*) filter (where raw_body ~ 'EMPRESA-APAGOU') arquivos_com_texto_empresa from webhook_events_log where received_at > now() - interval '2 hours';
select bucket, object_path, status from storage_redaction_queue where object_path like '%apg1%';
