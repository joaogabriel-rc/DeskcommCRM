---
impacto: capacidade_nova
secao: adicionado
titulo: O número que continua no aplicativo WhatsApp Business pode ser conectado pela Meta (coexistência)
---

Conectar WhatsApp com Meta passa a aceitar o número que você já usa no aplicativo WhatsApp Business, sem tirá-lo do celular. O cliente conversa pela API oficial e você segue respondendo pelo aplicativo: o que você envia pelo celular aparece na conversa do CRM, e o atendimento automático pausa naquela conversa enquanto você atende por lá, como já acontece na conexão por QR. O CRM pergunta à Meta se o número está em coexistência e mostra isso ao terminar a conexão. Conexões de números dedicados à API oficial continuam iguais.

Ainda não vêm para o CRM o histórico de conversas nem os contatos do aplicativo: aparecem as mensagens a partir da conexão. Para receber as mensagens enviadas pelo celular, o app da Meta da instalação precisa estar inscrito no campo de webhook `smb_message_echoes`. A atualização aplica a migration 0417 (duas colunas novas em `channel_sessions`), sem ação manual.
