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
 * Que o template existe e está aprovado na plataforma. Isso é estado remoto,
 * espelhado em `meta_templates`, e quem o confere é `conferirDefinicao()` na
 * borda do envio — inclusive a contagem de valores por slot, que depende do
 * contrato aprovado. Aqui só se cobra o que é verificável sem rede: nome e
 * idioma preenchidos.
 */
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
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  nos: NoParaValidar[],
): string[] {
  const problemas: string[] = [];

  const def = FLOW_TRIGGERS[triggerType as FlowTriggerId];
  if (!def) {
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
          `Em ${nome}, o envio fora da janela de 24 horas exige um template aprovado: informe o nome e o idioma.`,
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
