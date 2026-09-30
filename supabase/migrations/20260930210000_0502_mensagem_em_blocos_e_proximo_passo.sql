-- 0502 — O nó de mensagem em BLOCOS, com atraso dentro do nó e "Próximo passo"
-- separado do botão.
--
-- ── O que o construtor passa a oferecer ──────────────────────────────────────
--
-- Um único nó "Enviar mensagem" contém uma sequência de blocos — texto, imagem,
-- atraso — e cada texto pode ter botões. O botão ABRE UM SITE (URL) ou é uma
-- SAÍDA do fluxo (sem URL). E todo nó de mensagem tem o seu "Próximo passo",
-- que NÃO é um botão: o fluxo segue por ele mesmo que ninguém clique.
--
-- A definição do nó mora em `flow_nodes.config` (jsonb), e ela não precisa de
-- coluna nova: `config.blocks` convive com o `body`/`buttons` antigo, que é lido
-- como um bloco só (`lib/flows/blocos.ts`). Nenhum fluxo existente é reescrito.
--
-- ── O que precisa de coluna: o estado DURÁVEL da execução ─────────────────────
--
--   `node_cursor`       o próximo bloco a executar DENTRO do nó. Um atraso entre
--                       blocos vira `waiting_for = 'delay'` com o nó e este
--                       cursor gravados; a retomada reentra o MESMO nó a partir
--                       daqui. Gravado a cada bloco enviado: um worker que
--                       reinicia no meio do nó não reenvia o que já saiu.
--   `listening_node_id` o nó de mensagem cujos botões de fluxo continuam
--   `listening_until`   CLICÁVEIS depois que o fluxo seguiu pelo "Próximo
--                       passo". Um clique tardio DESVIA esta mesma execução
--                       para a saída do botão (decisão do dono do produto): a
--                       espera em curso é cancelada e, se a execução já tinha
--                       terminado, ela é reaberta — a mesma linha, sem briga
--                       com os índices únicos de execução ativa.
--
-- Sem backfill: execução antiga tem os três nulos e se comporta como antes.

alter table public.flow_executions add column if not exists node_cursor int;
alter table public.flow_executions add column if not exists listening_node_id uuid;
alter table public.flow_executions add column if not exists listening_until timestamptz;

do $$ begin
  alter table public.flow_executions
    add constraint flow_executions_listening_node_fk
    foreign key (listening_node_id) references public.flow_nodes(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.flow_executions
    add constraint flow_executions_node_cursor_check
    check (node_cursor is null or node_cursor >= 0);
exception when duplicate_object then null; end $$;

-- O handler de resposta procura "algum botão deste contato ainda clicável".
create index if not exists idx_flow_executions_listening
  on public.flow_executions (organization_id, contact_id, listening_until)
  where listening_node_id is not null;

comment on column public.flow_executions.node_cursor is
  'Próximo bloco a executar dentro do nó de mensagem em blocos (0502). Nulo fora de um nó em andamento.';
comment on column public.flow_executions.listening_node_id is
  'Nó de mensagem cujos botões de fluxo seguem clicáveis depois do Próximo passo (0502). Clique desvia esta execução.';
comment on column public.flow_executions.listening_until is
  'Até quando o clique tardio num botão de fluxo ainda desvia a execução (0502).';
