---
impacto: capacidade_nova
secao: adicionado
titulo: O WhatsApp oficial passa a conectar com um botão, entrando na conta da Meta
---

Em Conexões › API Oficial aparece o botão "Conectar WhatsApp com Meta". Quem
administra a empresa entra na própria conta da Meta, escolhe a conta do WhatsApp
Business e o número, e o CRM guarda a autorização sozinho — sem copiar ID de
número, ID de conta nem token do painel da Meta. A tela mostra até quando essa
autorização vale, quando a Meta informa uma data.

Para o botão aparecer, a instalação precisa de um app da Meta com o Cadastro
Incorporado (Embedded Signup) configurado: `META_APP_ID` e
`META_EMBEDDED_SIGNUP_CONFIG_ID` no arquivo de instalação, e a chave secreta do
app cadastrada em Admin › API Oficial (Meta). Sem isso, nada muda: a conexão
manual continua disponível como antes, agora em "Conexão manual / avançado".
Números que já usam o aplicativo WhatsApp Business (coexistência) ainda não são
conectados por este caminho.
