# Prova visual — mensagem apagada (11/11/2026)

Ambiente: stack Supabase fresca local (baseline.sql), app em `next build` + `next start`
na porta 3210, conta de teste local. Entregas no formato da Meta, assinadas com o
segredo de teste, pela rota universal (`cenarios-apagamento.mjs`). Estado lido com
`estado-apg.sql` no banco de prova.

| Cenário | Resultado |
|---|---|
| Texto recebido, apagado pelo contato | `body` nulo, `metadata` sem o texto, `metadata.apagamento` gravado; bolha "Esta mensagem foi apagada" |
| Imagem recebida com legenda, apagada pelo contato | colunas de mídia nulas, legenda e id da mídia fora do `metadata`, arquivo na `storage_redaction_queue` (`pending`) |
| Texto da empresa (eco do app), apagado pela empresa | texto mantido; bolha "Visível só aqui no CRM" |
| Prévia da conversa | era o texto secreto, virou "Esta mensagem foi apagada" |
| `event_log` | `body_preview` removido dos eventos das recebidas apagadas; o da empresa fica |
| API `GET /api/v1/conversations/:id/messages` (sessão do navegador) | 200, nenhuma ocorrência do texto secreto nem do id da mídia |
| Reentrega dos três apagamentos | `alteracao_ja_aplicada`, nada muda, fila com 1 arquivo |
| Linhas apagadas na prova anterior (regra antiga, corpo ainda no banco) | a API as entrega mascaradas (`canal: "desconhecido"`); o banco não foi limpo (decisão 4) |

**Simulação declarada:** o worker de mídia não alcança a Meta localmente, então a
imagem não tinha arquivo no Storage. Para exercitar a fila, `media_storage_path` foi
gravado à mão nessa linha, só no banco de prova, antes do apagamento.

- `01-antes-conversa.jpg` — antes: prévia e bolha com o texto secreto.
- `02-depois-conversa.jpg` — depois (atualizado pelo Realtime, sem recarregar).
