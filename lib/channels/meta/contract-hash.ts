/**
 * Hash do CONTRATO de um template — a âncora da trava por obsolescência.
 *
 * Uma configuração guarda o hash do template que ela escolheu (hoje, o nó de
 * mensagem do Flow Builder, em `template_contract_hash`). Hash divergente no
 * espelho significa que o template mudou na Meta depois da escolha — trabalho
 * visível (`bindingState` → `stale`), em vez de mensagem diferente da que o
 * operador aprovou saindo em produção.
 *
 * ── O que entra ─────────────────────────────────────────────────────────────
 *
 *   1. o que muda o PAYLOAD DE ENVIO: os slots (endereço + chave + tipo
 *      esperado, na ordem) — pega o 132000 (contagem) e o 132012 (formato do
 *      header) — e o `parameter_format` (POSITIONAL e NAMED montam parâmetros
 *      diferentes);
 *   2. o que o CONTATO VÊ e o que o fluxo LIGA: cada componente na ordem, com
 *      tipo, formato e texto, e cada botão com tipo, texto e destino (url,
 *      telefone). O texto de uma resposta rápida é o que o motor casa com a
 *      saída do nó (`casarRespostaDeBotao`); trocar "Confirmar" por "Sim" sem o
 *      hash mudar deixaria a saída ligada a um botão que não existe mais.
 *
 * ⚠️ Até 2026-09-23 a parte 2 ficava de fora, de propósito: "vírgula no corpo
 * não deve invalidar a config de ninguém". A régua mudou porque o consumidor
 * mudou — o nó de fluxo precisa saber que os BOTÕES mudaram —, e porque editar
 * o conteúdo de um template na Meta já o devolve para revisão: não é mudança
 * trivial. Nenhum outro lugar guarda este hash para comparar depois (os demais
 * comparam o espelho com ele mesmo), então a mudança não cria alarme em outra
 * parte. Na primeira sincronização depois da atualização, todo modelo recebe o
 * hash novo — uma vez.
 *
 * ── O que NÃO entra ─────────────────────────────────────────────────────────
 *
 * Os EXEMPLOS (`example`) que a Meta guarda para a revisão: não chegam ao
 * contato nem ao envio. E a ORDEM DAS CHAVES do JSON de entrada: a
 * serialização é montada AQUI, por arrays e literais sempre na mesma ordem —
 * nunca copiada do JSON, cuja ordem é do emissor e não vale confiança.
 */
import { createHash } from "node:crypto";

import { deriveTemplateContract } from "./template-contract";

type MetaComponents = Parameters<typeof deriveTemplateContract>[0]["components"];

type Bruto = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" ? v : null);
const maiuscula = (v: unknown): string | null => (typeof v === "string" ? v.toUpperCase() : null);

/**
 * O conteúdo, em forma canônica: um array por componente, na ordem declarada.
 * Arrays, e não objetos, para a serialização não depender de ordem de chave.
 */
function conteudoCanonico(components: unknown): unknown[] {
  if (!Array.isArray(components)) return [];
  return (components as unknown[]).map((bruto) => {
    const c = (bruto && typeof bruto === "object" ? bruto : {}) as Bruto;
    const botoes = Array.isArray(c.buttons)
      ? (c.buttons as unknown[]).map((b) => {
          const o = (b && typeof b === "object" ? b : {}) as Bruto;
          return [maiuscula(o.type), texto(o.text), texto(o.url), texto(o.phone_number)];
        })
      : [];
    const cards = Array.isArray(c.cards)
      ? (c.cards as unknown[]).map((card) => conteudoCanonico((card as Bruto | null)?.components))
      : [];
    return [maiuscula(c.type), maiuscula(c.format), texto(c.text), botoes, cards];
  });
}

/**
 * @param components  `components[]` cru do template, como a Graph API devolve.
 * @param parameterFormat  o `parameter_format` declarado pela Meta. Omitir vale
 *   POSITIONAL, que é o que ela assume quando o campo não vem. **Não é opcional por
 *   conveniência:** os mesmos `components` sob formatos diferentes exigem payloads
 *   diferentes, então precisam de hashes diferentes.
 */
export function hashContract(components: unknown, parameterFormat?: string): string {
  const contract = deriveTemplateContract({
    name: "",
    language: "",
    parameter_format: parameterFormat,
    components: components as MetaComponents,
  });
  const canonical = JSON.stringify({
    parameterFormat: contract.parameterFormat,
    slots: contract.slots.map((s) => [s.address, s.key, s.expects]),
    conteudo: conteudoCanonico(components),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
