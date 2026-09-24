---
impacto: capacidade_nova
secao: adicionado
titulo: Disparo pode levar o público por um fluxo, e o público é montado por grupos
---

O disparo ganhou dois modos. **Guiado** manda uma mensagem para o público, com o
modelo aprovado escolhido da mesma lista usada nos Fluxos — sem digitar nome nem
idioma. **Fluxo** leva cada contato do público por um fluxo próprio do disparo:
**Configurar fluxo** abre o mesmo construtor das automações, e dali saem
mensagens, botões com caminhos, esperas e condições. Esse fluxo é só do disparo,
não aparece em Automações e liga junto com o agendamento.

O público agora é montado em três grupos: **Todas estas (E)**,
**Pelo menos uma destas (OU)** e **Nenhuma destas (NÃO)**. Etiquetas e campos são escolhidos das
listas cadastradas, e o valor de cada campo vem no controle do tipo dele. Ao lado
da contagem aparece a regra exata de quem entra — a mesma que é usada ao agendar,
então o número mostrado é o número que sai.

Corrigido junto: uma etiqueta com vírgula no nome ("Cliente, VIP") era lida como
duas, e um valor com `%` ou `_` num filtro "contém" funcionava como curinga.
Agora os dois são texto.
