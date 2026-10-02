---
impacto: capacidade_nova
secao: alterado
titulo: O fluxo de um disparo que já saiu vira histórico, e o disparo pode ser duplicado
---

Em **Disparos**, o fluxo usado por um disparo fica guardado como foi: depois que
qualquer contato entra nele, o construtor abre em **somente leitura**, com o aviso
"Definição histórica" — ou "Fluxo em uso", com a quantidade de contatos que ainda
estão dentro. Dá para ver cada passo e a configuração, mas nada se altera, nem pela
tela nem por integração. Para mudar o caminho, use **Duplicar disparo**: nasce um
rascunho "(cópia)" com a mesma mensagem, o mesmo público e uma cópia independente
do fluxo (passos, botões, esperas, imagens e ligações), pronto para editar e agendar.
A cópia não leva execuções, destinatários nem mensagens enviadas.

Muda uma regra: um disparo **pausado** só deixa editar o fluxo enquanto ninguém
entrou nele. E um disparo que já processou destinatários — mesmo com todas as
mensagens recusadas — não pode mais ser apagado; cancele-o. Fluxos de Automações
continuam como antes. A atualização aplica a migration 0507, sem ação manual.
