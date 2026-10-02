---
impacto: capacidade_nova
secao: adicionado
titulo: Modelos da Meta com variáveis por nome, escolhidas pelo autocomplete e com exemplo obrigatório
---

No editor de Templates da Meta, digitar `{{` abre a lista de campos (primeiro nome, sobrenome, e-mail, celular e os campos personalizados que você cadastrou) e a variável entra no texto como uma etiqueta. Também dá para criar uma variável com o nome que você quiser, como `{{var1}}`. Para cada variável aparece um campo de exemplo, que a Meta exige para aprovar o modelo; o envio fica travado até todos estarem preenchidos. O exemplo serve só para a aprovação: o valor que cada contato recebe é definido no fluxo ou no disparo, e a variável criada pelo autocomplete já chega lá apontando para o dado certo do contato.

Correção junto: um modelo criado com variáveis por nome (como `{{var1}}`) era gravado no formato errado, e o envio era recusado pela Meta com o erro 132000. Os modelos já gravados assim passam a sair no formato certo, sem precisar sincronizar de novo.
