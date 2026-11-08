---
impacto: nada_mudou
secao: corrigido
titulo: A verificação de saúde não gera mais erro no log do banco
---

Cada consulta a `/api/v1/health` deixava um erro `permission denied for function
fn_user_org_ids` no log do Postgres. A verificação respondia "ok", mas o log de
uma instalação monitorada de perto ficava cheio de um erro que não era erro, e
isso escondia os erros reais. Agora a verificação lê o banco sem esbarrar em
permissão nenhuma, e o log fica limpo.

Nada foi liberado para visitantes não logados: eles continuam sem ver nenhuma
organização, e quem está logado continua vendo só as próprias. Nada precisa ser
configurado; a correção entra com a atualização do banco.
