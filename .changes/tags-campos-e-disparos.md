---
impacto: capacidade_nova
secao: adicionado
titulo: Automações ganham seção própria, com Tags, Campos do Usuário e Disparos
---

O menu tem uma seção nova, **Automações**, com **Fluxos** (que saiu de Canais) e
**Disparos**. E duas telas novas em Configurações: **Tags** e
**Campos do Usuário**.

**Tags** deixou de ser só a lista do que já tinha sido escrito. Agora dá para
criar uma etiqueta antes do primeiro uso, organizar em pastas, dar cor e
descrição — e cada uma tem um identificador que não muda quando o nome muda, que
é o que a sua integração com o N8N pode guardar. Renomear continua corrigindo os
contatos, os negócios, as conversas e as regras de agente na mesma operação, e
agora preserva o identificador. As etiquetas que você já usa aparecem lá
automaticamente na atualização.

**Campos do Usuário** é onde você declara o que guarda sobre cada contato:
produto de interesse, origem, matrícula, o que a sua operação pedir. Cada campo
tem nome, tipo (texto, número, data, data e hora, verdadeiro/falso, matriz),
descrição, pasta e identificador. O nome do campo muda à vontade; a chave, não —
é por isso que renomear um campo nunca apaga a variável das mensagens que já o
citam. Campo que não se usa mais é arquivado, não excluído: o valor continua
gravado em cada contato.

No **Fluxo**, o passo de ação passa a aceitar
**várias ações no mesmo passo**, na ordem que você definir — "define o produto
de interesse, define a origem, marca a tag" é um passo só, não três. Se uma delas falhar, as seguintes não
rodam e a mensagem depois dele não sai, para ninguém receber uma frase com
metade das variáveis em branco. O campo e a tag agora são escolhidos de uma
lista em vez de digitados, e o editor de mensagem ganhou o botão
**Inserir variável**, que monta a referência certa — inclusive para os campos
que você criou. Os valores dos espaços de um template aprovado também aceitam variável,
então dá para personalizar um envio fora da janela de 24 horas com o que as
ações gravaram no passo anterior.

**Disparos** é a tela de envio em massa. Você escolhe o público combinando tags
(tem todas / tem ao menos uma / não tem nenhuma) e campos do usuário, vê quantas
pessoas isso alcança antes de confirmar, escreve a mensagem (template aprovado,
ou texto livre para quem falou nas últimas 24 horas), agenda, acompanha o
andamento e pode pausar, retomar ou cancelar. O envio sai aos poucos, cerca de
uma mensagem a cada cinco segundos, para proteger o número — e ninguém recebe
duas vezes, nem se o disparo for reprocessado. Contato bloqueado, anonimizado,
mesclado ou sem telefone nunca entra, e isso não é um filtro que dê para
desligar.

Quem instalou antes desta versão não precisa fazer nada: a atualização cria as
tabelas, traz as etiquetas e os campos que já existiam e liga o relógio dos
disparos sozinha.

Dois limites para saber antes de montar: o público de um disparo é agendado em
lotes de até 5.000 contatos por vez (acima disso, estreite o filtro e faça em
partes); e o campo do usuário ainda não aparece no formulário do contato — lá
continuam valendo os campos declarados no funil.
