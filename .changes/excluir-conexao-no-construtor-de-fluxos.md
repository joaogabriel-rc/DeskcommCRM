---
impacto: capacidade_nova
secao: adicionado
titulo: Fluxos — dá para apagar só a ligação entre dois passos
---

No construtor de **Fluxos**, clicar numa linha que liga dois passos a
seleciona: ela fica destacada e mostra a lixeira **Apagar conexão** no meio.
A lixeira — ou as teclas **Delete** e **Backspace**, com a linha selecionada —
apaga só a ligação: os dois passos continuam no desenho, e a saída de onde ela
partia fica livre para ser ligada a outro passo. Ao **Salvar**, a ligação
apagada sai do fluxo e não volta ao reabrir.

Ligar uma saída que já levava a um passo agora troca o destino dela, em vez de
deixar duas ligações na mesma saída — antes o contato seguia só por uma delas, e
nada na tela dizia qual. E o **+** que adiciona um passo só o liga sozinho ao
anterior quando a saída dele está livre: não passa por cima de uma ligação que
você já fez.

Fluxo ativo continua só de leitura: para apagar uma ligação, pause o fluxo.

Quem instalou antes desta versão não precisa fazer nada.
