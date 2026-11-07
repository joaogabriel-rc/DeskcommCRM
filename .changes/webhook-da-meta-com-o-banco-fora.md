---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem do WhatsApp oficial não se perde mais quando o banco fica fora do ar
---

Quando o banco ficava indisponível, o endereço do webhook da Meta respondia que o
número não existia, mesmo para números conectados. Para a Meta, isso é uma
recusa: as mensagens daquele intervalo chegavam ao CRM horas depois, quando
chegavam. Agora, se o banco não responder, o CRM pede à Meta para entregar de
novo em seguida (resposta 503), e a mensagem entra assim que o banco volta.
Endereço com código que realmente não existe, ou de um canal excluído, continua
sendo recusado como antes.

Vale para o endereço universal (`/api/v1/webhooks/meta`) e para o endereço com
código no final. Nada precisa ser configurado.
