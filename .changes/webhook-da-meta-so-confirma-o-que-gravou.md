---
impacto: nada_mudou
secao: corrigido
titulo: O WhatsApp oficial só confirma à Meta a mensagem que ficou guardada no CRM
---

Quando o banco falhava no meio do recebimento, depois de identificar o número,
mas antes de gravar a mensagem, , o CRM respondia à Meta que estava tudo certo.
A Meta não enviava de novo, e a mensagem do cliente se perdia. O mesmo valia para
o "entregue", o "lido" e o "falhou" das mensagens enviadas e para a aprovação de
modelos. Agora o CRM só confirma o recebimento quando a mensagem ficou guardada,
e a Meta, que reenvia por até 7 dias, entrega de novo nos outros casos, sem
duplicar contato, conversa nem mensagem. Vale também para as mensagens
respondidas pelo aplicativo WhatsApp Business (coexistência).

- **Banco fora do ar ou lento:** a mensagem entra sozinha quando ele volta.
- **Atualização incompleta da instalação** (uma tabela ou coluna que ainda não
  existe, uma permissão errada): o CRM recusa a entrega e o registro do servidor
  avisa que é preciso corrigir a instalação. Corrigido dentro dos 7 dias, as
  mensagens que a Meta reenviar entram normalmente.
- **Mensagem que o banco recusa pelo próprio conteúdo:** ela é guardada inteira
  no arquivo de webhooks da organização, com o motivo, antes de o CRM confirmar
  à Meta, fica consultável e pode ser reprocessada depois de um conserto.

Nada precisa ser configurado.
