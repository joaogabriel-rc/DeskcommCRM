---
impacto: nada_mudou
secao: corrigido
titulo: O disparo mostra o resultado real do envio, e não "entrou no fluxo"
---

Quando o WhatsApp recusava uma mensagem de um disparo (por exemplo, um modelo com variável errada), o disparo terminava como concluído, contava a mensagem como enviada e não registrava falha nenhuma. Agora a mensagem recusada conta como falha, com o motivo que o canal devolveu, e "enviado" só conta mensagem que o canal aceitou. A recusa que chega minutos depois também corrige o disparo. Quem entrou no fluxo e ainda não recebeu nada, como numa espera antes da primeira mensagem, aparece como "em andamento", e o disparo só é concluído quando não resta ninguém nesse estado. A atualização aplica a migration 0501 sozinha; disparos antigos mantêm os números que já tinham.
