---
impacto: capacidade_nova
secao: corrigido
titulo: Número desconectado da API pelo WhatsApp Business deixa de aparecer como conectado
---

Quando o número é desconectado da API pelo app WhatsApp Business ou pelo
Gerenciador da Meta, a conexão oficial em **Conexões** agora mostra
**Parado**, com o aviso de que o número saiu da API, e a Central ganha um aviso
crítico dizendo o motivo que a Meta informou. Antes, ela continuava como
conectada e a única saída era excluí-la pela lixeira.

O CRM percebe a desconexão de dois jeitos: pelo aviso `account_update` que a
Meta envia ao webhook da instalação e pela verificação periódica do número.
Para receber o aviso na hora, assine também o campo **account_update** no
webhook do app da Meta. Sem ele, a verificação periódica detecta a desconexão
na rodada seguinte. Quando a verificação periódica também nota a queda, ela não
abre um segundo aviso para o mesmo problema, e a conexão segue como
**Parado** até ser conectada de novo. A conexão não é apagada: conversas e histórico continuam, e
conectar de novo, com o mesmo número ou com outro, reaproveita a mesma conexão.
