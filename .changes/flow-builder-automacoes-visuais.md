---
impacto: capacidade_nova
secao: adicionado
titulo: Fluxos — monte automações de WhatsApp arrastando passos numa tela
---

Uma tela nova, **Fluxos** (menu Automações), onde você monta o caminho que o
contato percorre sem escrever regra nenhuma: escolhe o que INICIA a automação,
adiciona os passos e liga um no outro.

O gatilho é uma escolha sua, e tag é só uma das opções. Dá para começar o fluxo
quando um contato novo entra, quando recebe ou perde uma tag, quando um campo
dele muda, no aniversário, quando manda uma mensagem no WhatsApp, quando um
negócio nasce, muda de etapa, é ganho ou perdido, e quando um horário é
marcado, confirmado ou cancelado.

Os passos disponíveis: **mensagem de WhatsApp** (com variáveis como
`{{contact.name}}` e botões — cada botão abre um caminho diferente conforme o
que a pessoa responder), **ação** (adicionar e remover tag, definir e limpar
campo, mover de etapa, atribuir responsável, atribuir a conversa, iniciar ou
parar outro fluxo), **condição** (segue por "sim" ou "não"), **espera** (de
minutos a dias, sem travar nada) e **webhook** (manda os dados para o seu
servidor ou para o N8N, com assinatura opcional).

A mensagem tem os dois modos que a plataforma do WhatsApp exige: dentro da
janela de 24 horas, texto livre; fora dela, template aprovado pelo canal
oficial. O fluxo nasce pausado, e editar o desenho exige pausar — o que já está
em andamento não muda de caminho no meio.

Duas coisas para saber antes de montar: os botões saem hoje como uma lista
numerada no texto (o contato responde "1" ou escreve a opção), porque a camada
de canal ainda não manda botão nativo; e nos gatilhos "negócio ganho" e
"negócio perdido" o passo de mensagem não sai — ação, condição e webhook
funcionam normalmente.

Quem instalou antes desta versão não precisa fazer nada: a atualização cria as
tabelas e o relógio do passo de espera sozinha.
