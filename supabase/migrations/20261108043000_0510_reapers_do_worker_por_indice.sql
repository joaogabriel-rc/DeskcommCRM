-- 0510 · Os reapers do worker param de varrer `event_log` e `messages` inteiros.
--
-- ─── O que derrubou a produção (07/11/2026) ─────────────────────────────────
-- Quatro consultas do worker rodam a cada poucos segundos e filtravam por um
-- estado que quase nunca tem linha — e nenhum índice cobria esse estado:
--
--   * reaper do dreno de despacho da IA (`lib/agent-engine/edge/crm/drain.ts`):
--       where event_type = 'ai_agent.dispatch_requested' and status = 'processing'
--         and $1 = any(consumed_by) and updated_at < now() - $2
--     a cada tique do dreno (2 s com trabalho, 15 s ocioso);
--   * reaper do dreno de handlers (`lib/event-log/drain.ts`):
--       where status = 'processing' and updated_at < $1
--     a cada tique (2 s / 10 s) — e de novo pelo cron `event-log-drain`;
--   * redrive e contagem do watchdog (`lib/agent-engine/edge/crm/session-reconciler.ts`):
--       where sent_via in ('ai','automation','system') and status = 'queued'
--         and created_at < now() - $1
--     a cada minuto.
--
-- Plano medido na produção (Supabase Nano, 0,5 GB): `Seq Scan on event_log`
-- descartando 58.327 linhas para achar zero, 5.186 buffers (~41 MB) por
-- execução; a contagem em `messages` lia 2.934 buffers e levava 1,2 s com o
-- cache quente. Como `event_log` não tem retenção, cada varredura fica mais cara
-- a cada dia. Com a tabela fora do cache isso esgotou o orçamento de E/S da
-- instância: as mesmas consultas passaram a levar de 10 a 74 s, o PostgREST não
-- conseguiu carregar o schema cache e o CRM ficou ~26 h fora do ar.
--
-- ─── O conserto ─────────────────────────────────────────────────────────────
-- Dois índices PARCIAIS sobre o estado que as consultas procuram. Eles guardam
-- só as linhas `processing` / `queued` — quase sempre zero —, então custam
-- 8 KB e não crescem com o histórico. Depois deles (medido na produção):
--   reaper da IA      Seq Scan 5.186 buffers 33,9 ms  ->  Index Scan 1 buffer 0,78 ms
--   reaper de handlers Seq Scan 5.186 buffers 34,8 ms  ->  Index Scan 1 buffer 0,12 ms
--   contagem watchdog  2.934 buffers 1.190 ms         ->  Index Scan 1 buffer 0,21 ms
-- Um índice por tabela serve às duas consultas de cada uma: o filtro restante
-- (`event_type`, `consumed_by`, `sent_via`) é aplicado sobre as poucas linhas
-- que o índice devolve. Os índices existentes não serviam:
-- `event_log_routing_active_unique` só vale para `conversation.routing_requested`,
-- e `idx_messages_org_status_created` só para `sending`/`failed` e começa por
-- `organization_id`, que estas consultas não filtram.
--
-- ─── Por que sem CONCURRENTLY aqui ──────────────────────────────────────────
-- O executor de migrations envolve o arquivo numa transação, e
-- `create index concurrently` não roda dentro de uma. Na produção os dois índices
-- foram criados à mão com CONCURRENTLY em 08/11/2026 (380 ms e 212 ms), então
-- este arquivo é um no-op lá. Num clone com `event_log` muito grande, o
-- `create index` comum segura escrita na tabela enquanto a constrói; quem quiser
-- evitar isso roda antes, fora de transação:
--   create index concurrently if not exists event_log_processing_idx
--     on public.event_log (updated_at) where status = 'processing';
--   create index concurrently if not exists idx_messages_queued_created
--     on public.messages (created_at) where status = 'queued';
--
-- Idempotente: `if not exists`. Sem dado reescrito.

create index if not exists event_log_processing_idx
  on public.event_log (updated_at)
  where status = 'processing';

create index if not exists idx_messages_queued_created
  on public.messages (created_at)
  where status = 'queued';
