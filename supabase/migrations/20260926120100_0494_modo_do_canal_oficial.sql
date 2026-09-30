-- 0494 · O modo do canal oficial: Cloud API dedicada ou coexistência com o app
-- WhatsApp Business.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- O Cadastro Incorporado da Meta passa a aceitar o número que CONTINUA no
-- aplicativo WhatsApp Business (fluxo "coexistence"): o cliente conversa pela
-- Cloud API e o dono segue respondendo pelo celular. O canal precisa saber qual
-- dos dois ele é — a tela mostra, e a fase seguinte (histórico e contatos) só
-- existe para quem está em coexistência, com prazo de 24h contado do onboarding.
--
--   meta_modo           'cloud_api' | 'coexistencia'. Quem decide é a META, e
--                       nunca o evento que o navegador repassa: o CRM pergunta
--                       `is_on_biz_app` ao número ao conectar. Nulo = não se sabe
--                       (conexão anterior a esta migration, ou a Meta não
--                       respondeu a pergunta — a conexão segue mesmo assim).
--   meta_onboarding_em  quando o número passou pelo Cadastro Incorporado. Nulo
--                       no formulário manual, que não é onboarding.
--
-- ─── Por que COLUNA com CHECK, e não `metadata` jsonb ────────────────────────
-- Mesma razão da 0311 e da 0398: chave dentro de `metadata` é contrato que o
-- update do ingest apaga sem avisar, e há mais de um leitor. `text` + CHECK e não
-- enum, pela doutrina de modelagem. O vocabulário vive em
-- `lib/channels/meta/modo-do-canal.ts` (MODOS_DO_CANAL_OFICIAL), e o par é
-- cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
--
-- ─── Exposição: nenhuma nova ────────────────────────────────────────────────
-- Herda o acesso das colunas vizinhas de `channel_sessions` (RLS por
-- organização). Sem grant, policy ou índice novos.
--
-- ─── Banco sem esta migration não quebra ────────────────────────────────────
-- O código grava estas colunas num update PRÓPRIO: sem elas, a conexão acontece
-- igual e só o modo deixa de ser guardado (log de aviso). Sem dado tocado: as
-- colunas nascem nulas e nenhuma linha viola o CHECK.

alter table public.channel_sessions
  add column if not exists meta_modo text,
  add column if not exists meta_onboarding_em timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_meta_modo_check'
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_meta_modo_check
      check (meta_modo = any (array['cloud_api'::text, 'coexistencia'::text]));
  end if;
end $$;

comment on column public.channel_sessions.meta_modo is
  'Modo do canal oficial, como a Meta respondeu (is_on_biz_app) ao conectar: cloud_api = número só na Cloud API; coexistencia = número que continua no app WhatsApp Business. Nulo = desconhecido.';

comment on column public.channel_sessions.meta_onboarding_em is
  'Quando o número passou pelo Cadastro Incorporado da Meta. Nulo = conexão pelo formulário manual ou anterior à migration 0494.';
