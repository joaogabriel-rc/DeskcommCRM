---
impacto: capacidade_nova
secao: adicionado
titulo: Número em coexistência pede o histórico e os contatos do aplicativo à Meta e guarda o que chega
---

Num número conectado que continua no aplicativo WhatsApp Business, o CRM passa a pedir à Meta o histórico de conversas e os contatos do aplicativo — sozinho, ao concluir a conexão, ou pelo botão "Pedir histórico e contatos" na página do canal oficial. A Meta só atende esse pedido em até 24 horas da conexão, e uma vez só; a página mostra o prazo e o estado de cada pedido. Nesta versão o que chega fica guardado, mas ainda não aparece nas conversas nem na lista de contatos, e nada dispara atendimento automático ou distribuição. Para receber, o app da Meta da instalação precisa estar inscrito nos campos de webhook `history` e `smb_app_state_sync`. A atualização aplica a migration 0495 (duas tabelas novas), sem ação manual.
