# Mensagem apagada e a exportação LGPD

> Regra documentada em 11/11/2026, a partir da decisão do dono do produto de
> 10/11/2026. **Nenhuma mudança de código na exportação foi feita**: este
> documento registra o comportamento atual, a regra proposta e as dúvidas
> jurídicas que precisam de resposta antes de implementar qualquer coisa.

## O que mudou no apagamento (já implementado)

| Quem apagou | O que acontece | Onde mora |
|---|---|---|
| **O contato** apagou uma mensagem **recebida** | O conteúdo é apagado de todo lugar, sem cópia restrita: corpo, mídia (colunas e arquivo no Storage), transcrição, conteúdo do `metadata`, prévia da conversa, `body_preview` do `event_log`, corpo cru de `webhook_events_log` e trechos do RAG (`ai_chunks`). Ficam a linha, `revoked_at`, ids, tipo, direção e `metadata.apagamento` (`em`, `por`, `canal`, `conteudo: "removido"`). | `lib/messaging/apagamento.ts` |
| **A empresa** apagou uma mensagem **enviada** | Só `revoked_at`. O texto continua no banco e na tela como "Visível só aqui no CRM". | mesmo arquivo, ramo da enviada |

## Como a exportação LGPD se comporta hoje

A exportação (`lib/lgpd/export-collector.ts`, consultas de `messages` nas
linhas próximas de 1017 e 1461) seleciona
`id, conversation_id, direction, type, status, body, media_url, sent_at, created_at`.
Ela **não lê `revoked_at`**. Consequências, sem mudar uma linha:

1. **Recebida apagada pelo contato:** aparece na exportação com `body: null` e
   `has_media: false`, porque o conteúdo já não existe no banco. Nada é
   exportado que o titular apagou. Fica o registro de que existiu uma mensagem
   naquele instante.
2. **Enviada apagada pela empresa:** aparece com o texto completo, e **sem
   indicação de que foi apagada**. O titular recebe o texto de uma mensagem que,
   no WhatsApp dele, aparece como "Mensagem apagada".
3. **Linha apagada antes desta regra** (só `revoked_at`, corpo ainda gravado):
   apareceria com o texto. A auditoria só de leitura em produção (10/11/2026)
   contou **zero** mensagens apagadas, então hoje não existe linha nessa
   situação lá. Em instalações de outros operadores, pode existir.

## Regra proposta (ainda NÃO implementada)

- **R1. Não descartar o que a lei exige exportar.** A exportação continua
  incluindo a mensagem enviada apagada pela empresa: é dado pessoal tratado
  sobre o titular (art. 18, II, LGPD), e a empresa ainda o guarda.
- **R2. Dizer que foi apagada.** Acrescentar `revoked_at` à exportação, para que
  o titular saiba que aquela mensagem foi retirada da conversa no WhatsApp.
- **R3. Não reconstruir o que o titular apagou.** A recebida apagada sai sem
  conteúdo. A exportação nunca busca o texto em outra fonte (event_log,
  arquivo de webhook, backup).

## Dúvidas jurídicas que precisam de resposta antes de implementar

1. **Guarda obrigatória × apagamento imediato.** Existe obrigação legal ou
   regulatória de manter o conteúdo de mensagens recebidas (relação de consumo,
   prova de contratação, setor regulado como saúde ou financeiro) que conflite
   com apagar na hora? O Marco Civil (art. 15) exige guardar **registros de
   acesso a aplicação** por 6 meses, não o conteúdo, mas um nicho específico
   (clínica, imobiliária) pode ter regra própria. Se houver, a decisão 1
   precisa de exceção por organização, e não de cópia restrita para todas.
2. **R2 expõe uma decisão interna?** Mostrar ao titular que a empresa apagou
   uma mensagem enviada a ele é transparência (art. 6º, VI) ou pode ser
   considerado excesso? A recomendação técnica é mostrar, mas a decisão é
   jurídica.
3. **Controlador × operador.** Quando a instalação é de um revendedor (marca
   própria), quem decide a política de guarda é o controlador (a organização).
   É preciso confirmar se a regra "apagar na hora" pode ser imposta pelo
   produto, ou se precisa ser uma opção configurável do controlador.
4. **Backups.** O conteúdo apagado continua nos backups do banco até que eles
   expirem. É preciso definir se isso é aceitável (prática comum, com prazo
   declarado) e documentar o prazo na política de privacidade do operador.

## Rastreabilidade técnica que fica

- A linha de `messages`, com `revoked_at` e `metadata.apagamento`.
- O `logger.info("[apagamento] conteúdo de mensagem recebida apagada removido")`,
  com `organization_id`, `message_id`, `conversation_id` e `canal`. **Nunca**
  registra o conteúdo.
- O evento de `event_log` continua existindo, só sem `body_preview`/`body`.
- O registro de `webhook_events_log` continua existindo, com `archived_at`
  carimbado e sem `raw_body`, `payload_parsed` e `headers`.
