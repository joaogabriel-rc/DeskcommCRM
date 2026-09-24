-- 0393 · O fluxo nasce sem gatilho, e o catálogo de modelos deixa de ser
--        gravável pelo cliente.
--
-- ─── 1. `flows.trigger_type` aceita "ainda não escolhido" ───────────────────
-- "Novo fluxo" passou a abrir direto no construtor, e o gatilho é escolhido
-- DENTRO do nó "Quando…". Entre o clique e a escolha, o fluxo existe como
-- rascunho — e a coluna era `not null default 'contact_tag_added'`, então esse
-- rascunho nasceria DIZENDO que escuta "tag atribuída", sem tag nenhuma. Um
-- default plausível é exatamente o que a doutrina proíbe: parece configurado e
-- não está.
--
-- Nulo passa a significar "gatilho ainda não escolhido". O que NÃO muda:
--   * o CHECK do vocabulário continua o mesmo — nulo passa por ele por
--     definição do SQL, e valor inventado continua recusado;
--   * nenhuma linha existente é tocada — todo fluxo já salvo tem gatilho e o
--     mantém;
--   * o motor só lê fluxos `active` (`lib/flows/trigger.handler.ts`), e ativar
--     um fluxo sem gatilho é recusado em `lib/flows/validacao.ts` com a frase
--     que diz o que falta. Nulo é estado de RASCUNHO, nunca de execução.
--
-- ─── 2. `meta_templates` passa a ser só-leitura para quem usa a tela ────────
-- A policy da 0088 era `for all` para qualquer membro da organização: um
-- `viewer`, pela REST, conseguia reescrever `status` (marcar APROVADO o que a
-- Meta recusou) e `components` — e é de `components` que sai o TEXTO gravado na
-- conversa quando um modelo é enviado. Adulterar ali é reescrever o histórico
-- do que o cliente recebeu.
--
-- O espelho tem um dono só: o servidor. Todo escritor do produto já usa o
-- admin client — o sync (`lib/channels/meta/template-sync.ts`), os webhooks de
-- status (Meta e parceiros), as rotas de modelo do parceiro e a rota que salva
-- o link da mídia. Então fechar a escrita para os papéis do PostgREST não
-- quebra caminho nenhum; só fecha a porta que nenhuma tela usava.
--
-- A leitura continua para todo membro da organização (o inbox e o construtor
-- de fluxos mostram os modelos), e continua isolada por organização.
--
-- ⚠️ POLICY SÓ DE SELECT NÃO BASTA, e por isso há `revoke`. Todo projeto
-- Supabase nasce com um default ACL que concede tudo aos papéis do PostgREST
-- (a lição da migration 0258). Sem policy de escrita a RLS já recusaria, mas o
-- `revoke` tira a escrita no nível do privilégio — a mesma régua de
-- `api_audit_log`. `service_role` mantém tudo: é o servidor.
--
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

alter table public.flows alter column trigger_type drop not null;
alter table public.flows alter column trigger_type drop default;

comment on column public.flows.trigger_type is
  'Gatilho que o fluxo escuta (catálogo em lib/flows/triggers.ts). Nulo = rascunho cujo gatilho ainda não foi escolhido no nó "Quando…" (migration 0393); ativar exige gatilho.';

-- A regra de ativação também no BANCO: fluxo `active` sem gatilho não existe,
-- venha a escrita da rota, do MCP ou de um script. Nenhuma linha anterior a
-- esta migration a viola — a coluna era `not null` até a linha acima —, então
-- não há dado a corrigir antes da constraint. Em bloco, para reaplicar sem erro.
do $$ begin
  alter table public.flows
    add constraint flows_ativo_exige_gatilho
    check (status <> 'active' or trigger_type is not null);
exception when duplicate_object then null; end $$;

drop policy if exists tenant_isolation_meta_templates_all on public.meta_templates;
drop policy if exists meta_templates_select on public.meta_templates;
create policy meta_templates_select on public.meta_templates
  for select
  using (organization_id in (select public.fn_user_org_ids()));

revoke insert, update, delete, truncate on public.meta_templates from anon, authenticated;
