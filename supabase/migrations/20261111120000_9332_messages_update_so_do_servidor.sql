-- 9332 — UPDATE em public.messages é só do servidor, e o que foi apagado não volta.
--
-- ─── O defeito (medido em 11/11/2026, banco fresco do baseline) ─────────────
-- A policy `messages_update` valia para `public` com a condição única "pertence
-- à organização", e `anon`/`authenticated` tinham GRANT de tudo, TRUNCATE
-- inclusive. O mesmo JWT que o navegador recebe chega ao PostgREST — onde não há
-- papel, autoria, janela de edição nem auditoria. Um `viewer` (o menor papel):
--   - reescrevia o texto de qualquer mensagem da organização;
--   - DESFAZIA `revoked_at` e devolvia conteúdo a mensagem apagada pelo contato;
--   - falsificava status ("lida") e autor de mensagem enviada;
--   - movia mensagem entre conversas.
-- Mover para outra organização já era recusado (WITH CHECK) — o isolamento
-- entre organizações não estava em jogo; a autorização DENTRO dela, sim.
--
-- ─── A correção (Fase 1, aprovada pelo dono do produto em 11/11/2026) ───────
-- 1. `anon`, `authenticated` e PUBLIC perdem UPDATE e TRUNCATE em `messages`,
--    na tabela (o que retira também o UPDATE de coluna). As três rotas que atualizavam com o cliente do
--    usuário (envio, editar/apagar a própria enviada, ocultar no CRM) passam a
--    gravar pelo service role DEPOIS da autorização da sessão, com
--    `organization_id` explícito.
--    O REVOKE é explícito e mora aqui (e no apêndice do baseline) porque o
--    Supabase cria `public` com um default ACL que concede tudo a esses papéis,
--    e o `GRANT ALL ON TABLE public.messages` do dump é reaplicado a cada
--    `update.sh`: enumerar privilégios não protege; revogar depois, sim (a
--    lição da migration 0258).
-- 2. A policy permissiva `messages_update` sai. Sem ela e sem o GRANT, nenhum
--    caminho do PostgREST atualiza mensagem. A `support_write_update`
--    (restritiva) pode ser recriada pela varredura de suporte enquanto a tabela
--    ainda tiver INSERT/DELETE para `authenticated` (Fase 2): ela só estreita, e
--    sem policy permissiva nem GRANT não concede nada.
-- 3. Trigger `trg_messages_imutaveis` (BEFORE UPDATE), que vale para TODOS os
--    papéis, service role e dono inclusive:
--      - `organization_id` e `direction` não mudam depois de gravados;
--      - `revoked_at` nunca volta a nulo (o apagamento não se desfaz);
--      - recebida apagada pelo contato não volta a ter conteúdo: o texto só pode
--        virar nulo ou o marcador `[mensagem anonimizada]` da cascata LGPD, e
--        mídia/transcrição só podem virar nulas.
--    É a regra das decisões de 10/11/2026 virando garantia do banco: um worker
--    que termina um download depois do apagamento, ou um bug numa rota de
--    servidor, recebe erro em vez de ressuscitar o conteúdo.
--
-- INSERT e DELETE seguem como estavam: são a Fase 2, com aprovação própria.
--
-- Idempotente; portável em psql puro; sem BEGIN/COMMIT.

-- (1) sem UPDATE e sem TRUNCATE para o PostgREST
revoke update, truncate on table public.messages from public, anon, authenticated;

-- O REVOKE de tabela também retira o UPDATE concedido coluna a coluna (é a
-- semântica do Postgres para REVOKE em tabela); o invariante da 9332 concede
-- UPDATE em colunas e prova que este bloco o retira.

-- (2) sem policy permissiva de UPDATE
drop policy if exists "messages_update" on public.messages;

-- (3) o que foi apagado não volta, para ninguém
create or replace function public.fn_messages_imutaveis()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'messages_imutavel: organization_id não muda (mensagem %)', old.id
      using errcode = '23514';
  end if;

  if new.direction is distinct from old.direction then
    raise exception 'messages_imutavel: direction não muda (mensagem %)', old.id
      using errcode = '23514';
  end if;

  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'messages_imutavel: apagamento não se desfaz (mensagem %)', old.id
      using errcode = '23514';
  end if;

  -- Recebida apagada pelo contato: conteúdo só sai, nunca entra.
  if new.direction = 'inbound' and new.revoked_at is not null then
    if new.body is not null
       and new.body is distinct from old.body
       and new.body <> '[mensagem anonimizada]' then
      raise exception 'messages_imutavel: recebida apagada não recebe texto (mensagem %)', old.id
        using errcode = '23514';
    end if;
    if (new.media_url is not null and new.media_url is distinct from old.media_url)
       or (new.media_storage_path is not null and new.media_storage_path is distinct from old.media_storage_path)
       or (new.media_mime is not null and new.media_mime is distinct from old.media_mime)
       or (new.media_size_bytes is not null and new.media_size_bytes is distinct from old.media_size_bytes)
       or (new.media_derived_text is not null and new.media_derived_text is distinct from old.media_derived_text) then
      raise exception 'messages_imutavel: recebida apagada não recebe mídia nem transcrição (mensagem %)', old.id
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

revoke execute on function public.fn_messages_imutaveis() from public, anon;

drop trigger if exists trg_messages_imutaveis on public.messages;
create trigger trg_messages_imutaveis
  before update on public.messages
  for each row execute function public.fn_messages_imutaveis();
