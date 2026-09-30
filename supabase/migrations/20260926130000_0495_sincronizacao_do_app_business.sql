-- 0495 · Sincronização do app WhatsApp Business — PRESERVAÇÃO (Fase 2.0).
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- Num número em coexistência (0494), a Meta entrega o histórico de conversas e a
-- agenda de contatos do aplicativo — mas só se o parceiro PEDIR, com
-- `POST /{phone}/smb_app_data`, em até 24h do onboarding, e UMA vez por tipo.
-- Esta migration guarda o pedido e o que chega, sem importar nada ainda:
--
--   meta_sincronizacoes          um pedido por (canal, onboarding, tipo): estado, request_id
--                                devolvido pela Meta, quando foi pedido, quando o
--                                primeiro payload chegou, e o erro.
--   meta_sincronizacao_payloads  o `value` BRUTO de cada webhook `history` e
--                                `smb_app_state_sync`, idempotente por
--                                (canal, campo, hash do payload): a reentrega da
--                                Meta não duplica.
--
-- ─── Por que nada é importado aqui ──────────────────────────────────────────
-- Gravar em `messages` dispara `message.received` (IA, push, fluxos) e criar
-- conversa dispara a distribuição de atendimento. A importação precisa de um
-- caminho próprio, sem esses efeitos, e fica para a fase seguinte. Estas tabelas
-- não têm trigger além do `updated_at`.
--
-- ─── Exposição ──────────────────────────────────────────────────────────────
-- Só o servidor lê e escreve (revoke de anon/authenticated, grant a
-- service_role); RLS por organização como segunda barreira. O payload bruto
-- carrega dados pessoais: sai junto com o canal ou a organização (cascade).
--
-- Vocabulário dos CHECKs em `lib/channels/meta/sincronizacao.ts`, cobrado pelo
-- invariante de vocabulário. Idempotente.

create table if not exists public.meta_sincronizacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  -- O onboarding a que o pedido pertence (= channel_sessions.meta_onboarding_em
  -- no momento do pedido). A Meta aceita UM pedido por tipo POR onboarding: quem
  -- desliga o número no app e conecta de novo ganha uma janela nova.
  onboarding_em timestamptz not null,
  tipo text not null,
  status text not null default 'pendente',
  request_id text,
  tentativa_em timestamptz,
  solicitada_em timestamptz,
  recebido_em timestamptz,
  erro text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_sincronizacoes_sessao_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete cascade,
  constraint meta_sincronizacoes_tipo_check check (tipo = any (array['contatos'::text, 'historico'::text])),
  constraint meta_sincronizacoes_status_check check (status = any (array[
    'pendente'::text, 'solicitando'::text, 'solicitada'::text, 'falhou'::text, 'expirada'::text, 'recusada'::text])),
  constraint meta_sincronizacoes_uma_por_onboarding unique (channel_session_id, onboarding_em, tipo)
);

create index if not exists meta_sincronizacoes_org_idx on public.meta_sincronizacoes (organization_id);

drop trigger if exists trg_meta_sincronizacoes_updated_at on public.meta_sincronizacoes;
create trigger trg_meta_sincronizacoes_updated_at before update on public.meta_sincronizacoes
  for each row execute function public.fn_set_updated_at();

create table if not exists public.meta_sincronizacao_payloads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  campo text not null,
  payload jsonb not null,
  payload_hash text not null,
  fase integer,
  chunk_order integer,
  progresso integer,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  constraint meta_sincronizacao_payloads_sessao_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete cascade,
  constraint meta_sincronizacao_payloads_campo_check check (campo = any (array['history'::text, 'smb_app_state_sync'::text])),
  constraint meta_sincronizacao_payloads_uma_entrega unique (channel_session_id, campo, payload_hash)
);

create index if not exists meta_sincronizacao_payloads_org_idx on public.meta_sincronizacao_payloads (organization_id);

alter table public.meta_sincronizacoes enable row level security;
alter table public.meta_sincronizacao_payloads enable row level security;

drop policy if exists tenant_isolation_meta_sincronizacoes_all on public.meta_sincronizacoes;
create policy tenant_isolation_meta_sincronizacoes_all on public.meta_sincronizacoes
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'admin'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'admin'));

drop policy if exists tenant_isolation_meta_sincronizacao_payloads_all on public.meta_sincronizacao_payloads;
create policy tenant_isolation_meta_sincronizacao_payloads_all on public.meta_sincronizacao_payloads
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'admin'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'admin'));

-- Só o servidor lê e escreve: o payload bruto carrega nomes, telefones e
-- mensagens, e nenhuma tela o lê direto. A policy acima (organização E papel
-- admin) fica como segunda barreira, se algum grant voltar por engano.
revoke all on public.meta_sincronizacoes from anon, authenticated;
revoke all on public.meta_sincronizacao_payloads from anon, authenticated;
grant select, insert, update, delete on public.meta_sincronizacoes to service_role;
grant select, insert, update, delete on public.meta_sincronizacao_payloads to service_role;

comment on table public.meta_sincronizacoes is
  'Pedidos de sincronização do app WhatsApp Business (coexistência): um por tipo (contatos, historico) por canal E por onboarding. A Meta aceita UM pedido por tipo, em até 24h do onboarding; uma reconexão é um onboarding novo, e os pedidos antigos ficam como histórico.';
comment on table public.meta_sincronizacao_payloads is
  'Payloads BRUTOS dos webhooks history e smb_app_state_sync, guardados sem importar nada (Fase 2.0 — preservação). Idempotente por (canal, campo, hash do payload).';
