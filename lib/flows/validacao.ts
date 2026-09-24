/**
 * O que impede um flow de ser LIGADO.
 *
 * ── Por que a checagem é na ativação, e não no rascunho ─────────────────────
 *
 * Rascunhar pela metade é o normal: o operador monta o desenho ao longo de uma
 * tarde e salva várias vezes. Cobrar completude a cada save transformaria o
 * canvas num formulário que não deixa sair.
 *
 * Ligar é outra coisa. A partir dali um contato de verdade entra no fluxo, e o
 * que estiver incompleto falha COM ELE DENTRO — a execução para no meio, o
 * `last_error` guarda o motivo numa tela que ninguém abre, e para o cliente
 * simplesmente não chegou nada.
 *
 * ── O caso que motivou o arquivo ────────────────────────────────────────────
 *
 * Um nó de mensagem em modo "fora da janela de 24 horas" SEM template
 * preenchido. `entradaDeEnvio` (lib/flows/nodes/message.ts) recusa com
 * `template_incompleto`, o que é o comportamento certo do motor — mas ele só
 * acontece DEPOIS de o gatilho já ter posto o contato para dentro, e o índice
 * único de execução por contato faz com que arrumar o flow depois não recupere
 * quem já entrou e falhou.
 *
 * A validação do GATILHO já existia e vivia inline na rota. Ela vem para cá
 * junto, porque são a mesma pergunta ("isto dispararia e faria algo?") e
 * porque uma delas na rota e outra num módulo é como as duas divergem.
 *
 * ── O que este arquivo NÃO consegue provar ──────────────────────────────────
 *
 * Que o template existe e está aprovado NA PLATAFORMA agora. O que dá para
 * saber sem rede é o ESPELHO (`meta_templates`), e isso mora em
 * `problemasDosModelos`, abaixo: a rota resolve cada modelo pelo catálogo
 * central e passa o resultado — esta função continua pura. A borda do envio
 * (`conferirDefinicao()`) segue conferindo de novo na hora de mandar.
 */
import { bindingState, explainBindingState, isStatusSendable } from "@/lib/channels/meta/template-binding";
import { acoesDoNo } from "@/lib/flows/acoes";
import { FLOW_TRIGGERS, type FlowTriggerId } from "@/lib/flows/triggers";
import type { ActionNodeConfig, FlowNodeType, MessageNodeConfig } from "@/lib/flows/types";

export interface NoParaValidar {
  id: string;
  type: FlowNodeType;
  label: string;
  config: Record<string, unknown>;
}

/** Como o nó é chamado na frase do erro: o rótulo dado, ou o tipo. */
function nomeDoNo(no: NoParaValidar, padrao: string): string {
  const rotulo = (no.label ?? "").trim();
  return rotulo ? `"${rotulo}"` : padrao;
}

/**
 * As frases que impedem a ativação. Lista vazia = pode ligar.
 *
 * Devolve TODAS as frases, não a primeira: quem está ligando um flow de doze
 * passos prefere consertar os três problemas de uma vez a descobrir um por
 * tentativa.
 */
export function problemasParaAtivar(
  triggerType: string | null,
  triggerConfig: Record<string, unknown>,
  nos: NoParaValidar[],
): string[] {
  const problemas: string[] = [];

  const def = triggerType ? FLOW_TRIGGERS[triggerType as FlowTriggerId] : undefined;
  if (!triggerType) {
    // Rascunho que nasceu no construtor (migration 0393): salvar sem gatilho é
    // permitido, ligar não — um fluxo sem gatilho nunca colocaria ninguém dentro.
    problemas.push("Escolha no passo \"Quando…\" o que inicia este flow antes de ativá-lo.");
  } else if (!def) {
    problemas.push("O gatilho deste flow não existe mais. Escolha outro antes de ligar.");
  } else if (def.field?.required) {
    const valor = triggerConfig?.[def.field.key];
    if (typeof valor !== "string" || !valor.trim()) {
      problemas.push(`Escolha ${def.field.label.toLowerCase()} no gatilho antes de ativar este flow.`);
    }
  }

  const mensagens = nos.filter((n) => n.type === "MESSAGE");
  for (const no of mensagens) {
    const config = no.config as MessageNodeConfig;
    const nome = nomeDoNo(no, "o passo de mensagem");
    if (config.window_mode === "outside_24h") {
      if (!config.template_name?.trim() || !config.template_language?.trim()) {
        problemas.push(
          `Em ${nome}, o envio fora da janela de 24 horas exige um template aprovado: escolha o modelo.`,
        );
      }
    } else if (!config.body?.trim() && !(config.buttons ?? []).length) {
      // Sem corpo E sem botões não sobra nada para mandar. Só botões ainda
      // renderiza (eles saem como lista numerada), então isso não é problema.
      problemas.push(`Em ${nome}, escreva o texto da mensagem.`);
    }
  }

  // Um flow que só escuta e não faz nada não é erro de configuração, mas um
  // flow SEM nenhum passo além do gatilho nunca teve como ser intencional.
  if (nos.length > 0 && !nos.some((n) => n.type !== "TRIGGER")) {
    problemas.push("Este flow só tem o gatilho. Adicione ao menos um passo antes de ligar.");
  }

  for (const no of nos.filter((n) => n.type === "ACTION")) {
    if (acoesDoNo(no.config as ActionNodeConfig).length === 0) {
      problemas.push(`Em ${nomeDoNo(no, "o passo de ações")}, escolha ao menos uma ação.`);
    }
  }

  for (const no of nos.filter((n) => n.type === "WEBHOOK")) {
    const url = (no.config as { url?: string }).url;
    if (!url?.trim()) {
      problemas.push(`Em ${nomeDoNo(no, "o passo de webhook")}, informe a URL de destino.`);
    }
  }

  return problemas;
}

/**
 * O modelo ATUAL do catálogo para um nó de mensagem — o que a rota resolveu
 * por `resolverModelo` (lib/channels/catalogo-de-modelos.ts). `null` = não
 * localizado.
 */
export interface ModeloResolvido {
  name: string;
  language: string;
  status: string;
  contractHash: string;
  espacos: Array<{ valueKey: string; onde: string; key: string }>;
}

/**
 * O que impede a ativação por causa do MODELO escolhido em cada nó de mensagem
 * fora da janela. Pura: a rota resolve os modelos e passa o mapa (id do nó →
 * modelo atual).
 *
 * Duas gerações de nó, e cada uma é cobrada pelo que dá para saber dela:
 *
 *   - Nó com `template_id` (escolhido no seletor): o veredito é o de
 *     `bindingState`, a régua que o produto já usa — não localizado, não
 *     aprovado, ou MUDOU desde a escolha (contrato diferente do retrato). E
 *     cada espaço do contrato precisa de valor.
 *   - Nó ANTIGO, só com nome e idioma digitados: se o catálogo o localiza, vale
 *     a mesma cobrança de aprovação e de valores; se NÃO localiza, não barra.
 *     Espelho vazio (sync nunca rodado) é estado normal de instalação, e o
 *     envio ainda confere na plataforma — barrar aqui quebraria fluxos que
 *     funcionam. A tela mostra "modelo não localizado" no card.
 *
 * Nós sem modelo preenchido não aparecem aqui: `problemasParaAtivar` já os cobra.
 */
export function problemasDosModelos(
  nos: NoParaValidar[],
  resolvidos: Map<string, ModeloResolvido | null>,
): string[] {
  const problemas: string[] = [];
  for (const no of nos) {
    if (no.type !== "MESSAGE") continue;
    const config = no.config as MessageNodeConfig;
    if (config.window_mode !== "outside_24h") continue;
    const name = config.template_name?.trim();
    const language = config.template_language?.trim();
    if (!name || !language) continue;

    // Fora do mapa = a rota não conseguiu LER o catálogo para este nó. Isso não
    // é veredito sobre o modelo, e a borda do envio confere de novo.
    if (!resolvidos.has(no.id)) continue;
    const nome = nomeDoNo(no, "o passo de mensagem");
    const atual = resolvidos.get(no.id) ?? null;

    if (!atual) {
      if (config.template_id) {
        problemas.push(
          `Em ${nome}, o modelo escolhido (${name}, ${language}) não foi localizado no catálogo do número que envia — ele pode ter sido apagado, ou o número desconectado. Escolha o modelo de novo.`,
        );
      }
      continue;
    }

    const valores = config.template_values ?? {};
    if (config.template_id) {
      const binding = {
        name,
        language,
        // Nó escolhido antes de o retrato do contrato existir compara com o
        // atual: sem o retrato não há como afirmar que mudou.
        contractHash: config.template_contract_hash ?? atual.contractHash,
        values: valores,
      };
      const estado = bindingState(binding, {
        name: atual.name,
        language: atual.language,
        contractHash: atual.contractHash,
        status: atual.status,
      });
      if (estado !== "ok") {
        problemas.push(`Em ${nome}: ${explainBindingState(estado, binding)}`);
        continue;
      }
    } else if (!isStatusSendable(atual.status)) {
      problemas.push(
        `Em ${nome}, o modelo ${name} (${language}) está ${atual.status} — a plataforma só entrega modelo aprovado.`,
      );
      continue;
    }

    const faltando = atual.espacos.filter((e) => !(valores[e.valueKey] ?? "").trim());
    if (faltando.length > 0) {
      problemas.push(
        `Em ${nome}, preencha ${faltando.length === 1 ? "o espaço" : "os espaços"} do modelo: ${faltando
          .map((e) => `{{${e.key}}} (${e.onde})`)
          .join(", ")}.`,
      );
    }
  }
  return problemas;
}
