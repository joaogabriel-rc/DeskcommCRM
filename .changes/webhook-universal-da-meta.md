---
impacto: capacidade_nova
secao: adicionado
titulo: Um endereço de webhook só para todas as empresas no WhatsApp oficial
---

O canal oficial da Meta passa a ter um webhook universal:
`https://<seu-domínio>/api/v1/webhooks/meta`. É o endereço que se cadastra uma
única vez no app da Meta, e ele serve a todas as empresas da instalação — cada
mensagem, confirmação de entrega e mudança de estado de modelo chega à empresa
dona do número que a recebeu. Com isso, a aprovação ou reprovação de um modelo
passa a chegar a todas as empresas que usam aquela conta do WhatsApp Business, e
não só a uma.

O endereço antigo, com o código no final, continua funcionando: os números já
conectados seguem recebendo por ele sem que nada precise ser mudado.
