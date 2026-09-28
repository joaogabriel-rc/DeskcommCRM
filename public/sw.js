/*
 * DESLIGADOR DE SERVICE WORKER LEGADO — não é o SW do produto.
 *
 * O SW do DeskcommCRM é `/notify-sw.js` (bandeja + Web Push). Nada no produto
 * registra `/sw.js`, e nada deve passar a registrar: este arquivo existe só
 * para devolver o domínio quando ele foi reaproveitado de um sistema anterior
 * que deixou um SW em `/sw.js` controlando o escopo `/`.
 *
 * Por que apagar não basta: com `/sw.js` respondendo 404, o navegador RECUSA a
 * atualização e mantém o SW antigo ativo — ele segue interceptando a navegação
 * e servindo do cache dele as telas do sistema anterior, e só Ctrl+Shift+R ou
 * "limpar dados do site" escapam. Na checagem de atualização (a cada navegação,
 * ignorando o cache HTTP) o navegador baixa ESTE arquivo, vê bytes diferentes,
 * instala e ativa; ele apaga os caches, remove o próprio registro e recarrega
 * as abas que controlava, que então chegam à rede e ao app atual.
 *
 * Sem ouvinte de `fetch` de propósito: nada é interceptado nem por um instante.
 * O app atual não usa Cache Storage (nem o `/notify-sw.js`), então apagar todos
 * os caches da origem não tira nada dele. Remover o registro de `/` não afeta
 * quem já tem o `/notify-sw.js`: o navegador só busca `/sw.js` para registros
 * cujo script é `/sw.js`, e o app o registra de novo quando precisa.
 *
 * Quando remover: quando não houver mais navegador que visitou o domínio no
 * tempo do sistema anterior. Remover cedo demais devolve o sintoma a quem
 * ainda não voltou desde então; mantê-lo não custa nada a quem nunca o teve.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const nomes = await self.caches.keys();
        await Promise.all(nomes.map((nome) => self.caches.delete(nome)));
      } catch {
        // Sem Cache Storage: segue para o desregistro, que é o que importa.
      }
      await self.registration.unregister();
      const abas = await self.clients.matchAll({ type: "window" });
      await Promise.all(
        abas.map((aba) =>
          "navigate" in aba ? aba.navigate(aba.url).catch(() => undefined) : undefined,
        ),
      );
    })(),
  );
});
