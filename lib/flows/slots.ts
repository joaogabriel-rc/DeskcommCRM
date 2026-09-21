/**
 * Os ESPAÇOS de um template aprovado, como a tela os edita.
 *
 * ── Por que a chave do espaço é editável, e não só o valor ──────────────────
 *
 * A chave que o envio espera não é sempre `1`, `2`, `3`. Quem a define é
 * `slotKey()` (lib/channels/meta/build-components.ts), a partir de ONDE o
 * parâmetro está no template aprovado:
 *
 *   corpo    → `1`, `2`, …           (sem prefixo — é o caso comum)
 *   cabeçalho→ `header:1`
 *   botão    → `button0:1`
 *   carrossel→ `card0:` + o de dentro
 *   nomeado  → `customer_name` (a Meta aceita `{{nome}}` além de `{{1}}`)
 *
 * Enquanto a tela numerava sozinha e mostrava o número como texto fixo, todo
 * template com variável no CABEÇALHO ou em BOTÃO era impossível de configurar
 * por aqui: o valor ia para a chave `1`, `conferirDefinicao()` reclamava do
 * slot `header:1` faltando, e não havia onde digitar essa chave. Numerar
 * continua sendo o padrão ao adicionar; o que muda é poder corrigir.
 */

/** O próximo número posicional livre, para o botão "Adicionar espaço". */
export function proximoSlot(valores: Record<string, string>): string {
  const usados = new Set(Object.keys(valores));
  let n = 1;
  while (usados.has(String(n))) n += 1;
  return String(n);
}

/**
 * Renomeia um espaço sem perder o valor e sem colapsar dois espaços.
 *
 * ── Sobre a ORDEM, e o que esta função NÃO consegue prometer ────────────────
 *
 * Esta função foi escrita afirmando que preservava a ordem de inserção. É
 * falso, e o teste `renomear preserva a ORDEM` pegou o erro:
 *
 *     Object.keys({ "1": …, "header:1": …, "3": … })  →  ["1", "3", "header:1"]
 *
 * JavaScript ordena as chaves de um objeto que PARECEM índice inteiro primeiro,
 * em ordem numérica, e só depois as demais, em ordem de inserção. Não é o
 * `Object.fromEntries` daqui: é regra da linguagem, e vale para qualquer objeto
 * — inclusive o que vem do jsonb.
 *
 * Viver com isso é a decisão certa, e não um contorno: `template_values` é um
 * `Record<string, string>` por contrato com a camada de canal
 * (`lib/schemas/messaging.ts`), e trocar por lista de pares para ganhar ordem
 * mudaria o payload de envio inteiro por um detalhe de apresentação. O efeito
 * prático é que os espaços posicionais (1, 2, 3) aparecem antes dos
 * qualificados (`header:1`, `button0:1`) — que é uma ordem razoável de ler.
 *
 * O que a função PROMETE, e o teste vigia: o valor sobrevive à renomeação, e
 * renomear para uma chave que já existe é ignorado — senão dois espaços
 * colapsariam em um e um valor sumiria sem aviso.
 */
export function renomearSlot(
  valores: Record<string, string>,
  de: string,
  para: string,
): Record<string, string> {
  if (de === para) return valores;
  const limpo = para.trim();
  if (!limpo || Object.prototype.hasOwnProperty.call(valores, limpo)) return valores;
  return Object.fromEntries(
    Object.entries(valores).map(([chave, valor]) => (chave === de ? [limpo, valor] : [chave, valor])),
  );
}
