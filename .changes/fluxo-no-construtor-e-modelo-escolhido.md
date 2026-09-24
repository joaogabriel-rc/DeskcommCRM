---
impacto: capacidade_nova
secao: alterado
titulo: Fluxo novo abre direto no construtor, e o modelo aprovado é escolhido de uma lista
---

**Novo fluxo** não pergunta mais nada antes de abrir: ele cria um rascunho
"Sem título" e leva direto ao construtor. O primeiro passo, **Quando…**, já
vem com **+ Novo gatilho** — é ali que se escolhe o que inicia o fluxo (tag
atribuída, contato novo, mensagem recebida e os demais). Dá para salvar o
rascunho sem gatilho quantas vezes quiser; para **Ativar**, ele continua
obrigatório, e a tela diz onde escolher. O nome se edita no próprio cabeçalho
do construtor.

No passo de mensagem **fora da janela de 24 horas**, o modelo aprovado deixou
de ser digitado: **Escolher modelo de mensagem** abre a lista dos modelos
aprovados do número oficial, com busca por nome, idioma e categoria. Escolhido
o modelo, o passo mostra a mensagem como ela vai chegar — cabeçalho, texto,
rodapé e botões —, e os espaços a preencher (`{{1}}`, cabeçalho, botão de link)
aparecem sozinhos, cada um com o seu campo. As **respostas rápidas** do modelo
viram as saídas do passo: ligue cada uma ao caminho que ela deve seguir. Ao
ativar, o CRM confere se o modelo continua aprovado, se mudou na plataforma
depois de escolhido e se todo espaço tem valor.

Passos antigos, configurados com o nome digitado, continuam funcionando. Se o
modelo for encontrado na lista, o passo o mostra e oferece
**Vincular a este modelo**; se não for, avisa que não o localizou.

Corrigido junto: quando o contato tocava num botão de modelo aprovado no canal
oficial, a resposta não era registrada — a conversa não a mostrava e o fluxo
que esperava por ela ficava parado. Agora ela chega como a mensagem com o texto
do botão tocado.

E o espelho dos modelos aprovados passou a ser só-leitura para quem usa a
tela: status e conteúdo de um modelo só mudam pela sincronização com a Meta.
