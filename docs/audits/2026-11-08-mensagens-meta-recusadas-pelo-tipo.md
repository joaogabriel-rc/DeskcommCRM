# Mensagens do WhatsApp oficial recusadas pelo tipo, 01 a 08/11/2026

## O que aconteceu

O parser do webhook da Meta (`lib/channels/meta/webhook.ts`) repassava a
`messages.type` o `type` cru que a Meta manda. A constraint `messages_type_check`
aceita só o vocabulário do CRM (`text`, `image`, `video`, `audio`, `document`,
`sticker`, `location`, `contact`, `reaction`, `system`, `template`). Todo outro
tipo falhava com `23514`, e o código em produção (`d30c7b1`) respondia **200** à
Meta e só registrava `[meta.ingest] inbound não ingerido` no log. Para a Meta, 200
é entrega concluída: nenhuma dessas mensagens foi reenviada.

## Quantas, e de que tipo

Medido nos logs do Postgres da produção (campo `parsed.detail`, coluna 7 da linha
recusada, só o `type`, sem ler o conteúdo), de 01/11 00:00 a 08/11 23:29 UTC:

| Tipo | Direção | Quantidade | O que é |
|---|---|---|---|
| `unsupported` | recebida | 106 | tipo que a Cloud API não entrega (enquete, GIF, convite de grupo…) |
| `interactive` | eco (saída) | 53 | mensagem com botões ou lista que a empresa mandou pelo app Business |
| `revoke` | recebida | 12 | o contato apagou uma mensagem |
| `edit` | recebida | 7 | o contato editou uma mensagem |
| `order` | recebida | 3 | pedido feito pelo catálogo |
| `unsupported` | eco (saída) | 2 | tipo não suportado enviado pelo app |
| **Total** | | **183** | |

Por dia: 01/11: 4 · 02/11: 5 · 03/11: 89 · 04/11: 29 · 05/11: 34 · 06/11: 10 ·
07/11: 5 · 08/11: 7 (de 06/11 a 07/11 o banco ficou indisponível por ~26 h e quase
nada entrou). Os logs consultados começam em 01/11; antes disso não há medição.

## Por que não dá para recuperar

- A Meta não reenvia o que recebeu 200.
- O corpo do webhook não era guardado em lugar nenhum (`webhook_events_log` não
  tem linha da Meta).
- O log do Postgres guarda a linha recusada, e nela o conteúdo já estava perdido:
  `body` nulo para `unsupported`, `interactive` e `order`; e `unsupported` nunca
  teve conteúdo, a própria Meta não o entrega.
- `revoke`/`edit` apontavam para mensagens que existem no CRM, mas o log não
  guarda qual (só o `wamid` do próprio evento de alteração).

Por decisão do dono do produto (08/11/2026), **nenhuma mensagem artificial é
inserida em produção** e nenhum conteúdo é reconstruído.

## A correção

- Conversão de todo tipo da Meta para um tipo aceito, com o original em
  `messages.metadata.meta_original` (`lib/channels/meta/tipos-da-meta.ts`).
- `revoke`/`edit` alteram a mensagem original, por organização, inclusive quando
  chegam antes dela (`lib/channels/meta/alteracao-de-mensagem.ts`).
- Mensagens sem conteúdo não disparam IA nem automações (migration 9254 +
  `respondeAoConteudo` em `lib/event-log/dispatcher.ts`).
- Cerca: `tests/unit/meta-tipos-cabem-na-constraint.test.ts` compara o que o parser
  produz com a última definição de `messages_type_check` no baseline.
