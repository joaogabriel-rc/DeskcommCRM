---
impacto: nada_mudou
secao: corrigido
titulo: Domínio reaproveitado de outro sistema não mostra mais as telas antigas
---

Quem instala o CRM num domínio que antes hospedava outro sistema podia continuar vendo a tela de login ou o painel do sistema anterior: um service worker deixado por ele em `/sw.js` seguia controlando o domínio e servindo as telas antigas do cache do navegador, e só Ctrl+Shift+R ou "limpar dados do site" resolviam. Agora o CRM responde em `/sw.js` com um desligador: na próxima visita, o navegador o recebe, apaga os caches do sistema anterior, remove o registro antigo e recarrega a aba já no CRM, sem nenhuma ação de quem usa. Nada muda para quem nunca teve o sistema anterior, e as notificações do CRM continuam funcionando como antes.
