---
impacto: nada_mudou
secao: corrigido
titulo: Modelo aprovado do número oficial volta a sair pela conversa
---

Enviar um modelo aprovado pelo número oficial podia falhar com "não está no
espelho", mesmo com o modelo aprovado e visível na tela de Conexões. A
sincronização com a Meta guarda cada modelo pela **conta** do WhatsApp
Business (WABA), e o envio procurava o modelo só pelo **número** da conversa,
então não o encontrava. Agora o envio procura o modelo do mesmo jeito que a
conferência feita antes de enviar: primeiro pelo número, depois pela conta
dele.

As recusas continuam valendo, e agora a conferência e o envio concordam:

- um modelo de **outra conta** não sai por este número, porque a plataforma só
  entrega o modelo pelo número da conta que o aprovou;
- um modelo **pausado, reprovado ou desativado** não sai, e o motivo aparece na
  mensagem;
- modelo inexistente ou com valor faltando é recusado antes de qualquer
  tentativa de envio.

Fluxos e configurações antigas que não guardam o número continuam funcionando:
se o modelo existe numa conta só da organização, ele é usado; se o mesmo nome e
idioma existem em duas contas, o envio não escolhe uma por conta própria e
recusa.
