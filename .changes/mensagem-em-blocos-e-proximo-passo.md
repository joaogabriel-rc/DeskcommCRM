---
impacto: capacidade_nova
secao: adicionado
titulo: Uma mensagem com vários blocos, atraso entre eles, botão de link e "Próximo passo"
---

O passo "Enviar mensagem" das Automações e dos Disparos em modo fluxo passa a aceitar uma sequência de blocos: textos, imagens e atrasos ("aguardar 3 segundos") dentro do mesmo passo, reordenáveis. Cada texto pode ter até três botões: um botão com link abre o site, e um botão sem link leva a uma etapa do fluxo. Todo passo de mensagem tem agora o seu "Próximo passo", separado dos botões: o fluxo segue por ele assim que a mensagem sai, mesmo que ninguém clique, e se o contato clicar num botão depois, o fluxo desvia para o caminho daquele botão. Passos antigos continuam funcionando como antes, e um passo com botões e sem "Próximo passo" ligado continua esperando o clique.

Os atrasos curtos são retomados pelo serviço de atendimento a cada 2 segundos (ajustável em `FLOW_DELAY_TICK_MS`; `0` devolve a tarefa ao agendador de 1 minuto). A atualização aplica a migration 0502 sozinha, sem ação manual.
