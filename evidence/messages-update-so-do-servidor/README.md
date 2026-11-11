# Prova, UPDATE em messages só do servidor (migration 9332, 11/11/2026)

Ambiente: stack Supabase fresca local (baseline.sql), com a migration 9332 aplicada
só nesse banco de prova; app em `next build` + `next start` na porta 3210; conta de
teste local (admin da organização).

## Antes (medição, em transação com ROLLBACK)

`medir-rls-messages.sql` simula o JWT de um **viewer**. Antes da 9332: reescrever
texto, desfazer `revoked_at` devolvendo conteúdo, falsificar status/autor, mover
entre conversas, inserir enviada forjada e apagar mensagem, **todos aceitos**.

## Depois

| Cenário | Resultado |
|---|---|
| `PATCH /rest/v1/messages` com o JWT do próprio usuário (admin): reescrever texto | 403 `42501 permission denied for table messages`, linha intacta |
| idem: desfazer o apagamento e devolver texto | 403, linha intacta |
| idem: marcar enviada como lida e trocar o autor | 403, linha intacta |
| Leitura pelo PostgREST (controle) | 200 |
| Enviar mensagem pela tela (`01-envio-pela-tela.jpg`) | aparece na conversa; o servidor gravou o desfecho (`queued` / `meta_not_configured`, o canal de prova não tem credencial da Meta) |
| Ocultar no CRM (`02-ocultar-no-crm.jpg`) | "Mensagem ocultada no CRM" |
| Restaurar no CRM (`03-restaurar-no-crm.jpg`) | mensagem volta ao normal |

Saída literal do ataque: `ataque-postgrest-depois.txt`; estado do banco:
`estado-depois.txt`.

**Não provado pela tela:** editar e apagar a própria mensagem enviada. O caminho
exige o canal aceitar a alteração (a Meta), o que o canal de prova não tem; a rota
recusa antes de gravar. A escrita do banco desses dois casos está provada no
invariante `tests/invariants/messages-update-so-do-servidor.test.ts` (service role
edita e apaga a enviada; ninguém do PostgREST consegue) e a rota pelos testes de
`app/api/v1/messages/[id]/route.test.ts`.
