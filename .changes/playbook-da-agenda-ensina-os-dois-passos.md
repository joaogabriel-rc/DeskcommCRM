---
impacto: nada_mudou
secao: corrigido
titulo: O playbook de agenda ensina os dois passos — listar o que a empresa atende e só depois consultar horários
---

O playbook `agendamento` é o texto que entra na conversa quando o cliente fala em "agendar", "horário disponível" ou "que horas vocês". Ele começava no meio da cadeia: dizia que a IA só tem acesso à agenda se `crm_find_free_slots` estiver disponível e mandava consultar horários, mas nunca dizia de onde vem o `event_type_slug` que essa ferramenta exige. O primeiro passo, `crm_list_event_types`, não aparecia em nenhuma linha do texto.

Por isso acontecia a cena da issue #1019: a IA listava os tipos de atendimento, parava ali e respondia "vou verificar", ou passava para a equipe, em vez de oferecer um horário real.

Agora o texto ensina a cadeia inteira. Primeiro `crm_list_event_types`, de onde sai o `slug` de cada tipo de atendimento. Depois, **no mesmo turno**, `crm_find_free_slots` com esse `event_type_slug`. Quando o cliente escolhe um horário, `crm_book_appointment` com o `starts_at` que a consulta devolveu. Parar depois da lista e responder "vou verificar" passa a ser descrito como o erro que é.

Cada ferramenta só é mencionada com a condição "se ela estiver na sua mão". O texto vale para a organização inteira e chega por palavra-chave, sem saber quais ferramentas o agente tem ligadas. Para o agente que não tem a ferramenta, nada muda: ele não inventa horário e avisa a equipe.

A atualização reaplica o `baseline.sql`, e isso já troca o texto padrão. Nenhuma ação é necessária. Uma organização que instalou este playbook pelo catálogo, ou o editou, tem uma cópia própria: essa cópia continua como está e não recebe o texto novo.

Contribuição de @webtecnica (#1922).
