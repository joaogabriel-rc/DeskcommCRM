-- 0384 · A validade do token do canal oficial.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- O Cadastro Incorporado da Meta (Embedded Signup v4) entrega um token de
-- integração do negócio do cliente cuja validade DEPENDE DA CONFIGURAÇÃO do app:
-- o template padrão da Meta se chama "…With 60 Expiration Token", e a própria
-- documentação da Meta não fixa um prazo único. O CRM não assume nenhum dos dois:
-- pergunta à Meta (`debug_token`, campo `expires_at`) e guarda a resposta aqui.
--
-- Nulo = não expira (a Meta respondeu `expires_at: 0`) OU desconhecido — que é o
-- caso de toda conexão pelo formulário manual, onde o CRM nunca soube a validade
-- do token colado. A tela só mostra a data quando ela existe.
--
-- ─── Por que COLUNA, e não `metadata` jsonb ─────────────────────────────────
-- Mesma razão da 0311: chave dentro de `metadata` é contrato que o update do
-- ingest apaga sem avisar, e há mais de um leitor (a rota GET do canal e a
-- conclusão do cadastro).
--
-- ─── Exposição: nenhuma nova ────────────────────────────────────────────────
-- Uma data, não um segredo. Herda o acesso das colunas vizinhas de
-- `channel_sessions` (RLS de isolamento por organização). Sem grant novo, sem
-- policy nova, sem índice (lida sempre pela chave primária da sessão).
--
-- ─── Banco sem esta migration não quebra ────────────────────────────────────
-- O código grava e lê esta coluna em consultas PRÓPRIAS: sem ela, a conexão
-- acontece igual e só a validade deixa de ser guardada (log de aviso).

alter table public.channel_sessions
  add column if not exists meta_token_expires_at timestamptz;

comment on column public.channel_sessions.meta_token_expires_at is
  'Até quando o token do canal oficial vale, como a Meta respondeu no debug_token ao conectar pelo Cadastro Incorporado. Nulo = não expira ou desconhecido (conexão manual).';
