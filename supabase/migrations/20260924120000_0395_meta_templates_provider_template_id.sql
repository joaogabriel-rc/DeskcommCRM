-- ---- o identificador que a Meta dá ao modelo criado pelo CRM (migration 0395) ----
--
-- Criar um modelo oficial pela tela (POST /{waba}/message_templates) devolve o
-- id que a Meta atribuiu a ele. Esta coluna o guarda.
--
-- O que ela NÃO é:
--
--   * não é a identidade local: `meta_templates.id` (uuid) continua sendo o que
--     Fluxos e Disparos guardam, e a chave natural continua sendo
--     (organização, conta, nome, idioma) — é por ela que o sync faz o upsert;
--   * não é obrigatória: modelo espelhado antes desta migration, ou trazido só
--     pela sincronização, fica com ela nula;
--   * não é única na instalação: a mesma conta (WABA) pode estar ligada a duas
--     organizações, e cada uma tem a SUA linha do mesmo modelo.
--
-- A unicidade é por (organização, conta, id da Meta): dentro de uma conta, um id
-- da Meta é um modelo num idioma. Cada idioma do mesmo nome recebe id próprio
-- na Meta, então o índice convive com vários idiomas e várias contas.

alter table public.meta_templates
  add column if not exists provider_template_id text;

comment on column public.meta_templates.provider_template_id is
  'Id que a Meta devolveu ao criar o modelo pelo CRM (migration 0395). Nulo em modelo antigo ou só sincronizado. Não é a identidade local (id) nem única na instalação: único por (organization_id, waba_id).';

-- Vazio não é identificador. Sem isto, '' viraria um "id" que colide consigo
-- mesmo no índice abaixo.
alter table public.meta_templates
  drop constraint if exists meta_templates_provider_template_id_nao_vazio;
alter table public.meta_templates
  add constraint meta_templates_provider_template_id_nao_vazio
  check (provider_template_id is null or btrim(provider_template_id) <> '');

-- Auto-cura antes do índice: se um clone chegou aqui com o mesmo id repetido na
-- mesma conta, só a linha sincronizada por último o mantém. A coluna é nova,
-- então num banco sadio isto não toca linha nenhuma.
with repetidos as (
  select id,
         row_number() over (
           partition by organization_id, waba_id, provider_template_id
           order by synced_at desc, id
         ) as ordem
    from public.meta_templates
   where provider_template_id is not null
)
update public.meta_templates m
   set provider_template_id = null
  from repetidos r
 where m.id = r.id
   and r.ordem > 1;

create unique index if not exists uq_meta_templates_provider_template_id
  on public.meta_templates (organization_id, waba_id, provider_template_id)
  where provider_template_id is not null;
