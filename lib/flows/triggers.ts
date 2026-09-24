/**
 * O CATÁLOGO DE GATILHOS — "Iniciar automação quando…".
 *
 * ═══ Por que um catálogo, e não uma lista de strings ═══
 *
 * A primeira versão desta feature tratava TAG como se fosse o flow ("flow de
 * tag"), e o gatilho nem aparecia na tela. Está errado: o gatilho é uma
 * ESCOLHA DENTRO do flow, e a tag é só uma das opções. Um catálogo declarativo
 * é o que faz gatilho novo ser uma entrada aqui, e não três lugares para
 * lembrar (o mesmo motivo que `ENTIDADE_ESPERADA_POR_GATILHO` existe do lado
 * da automação — ver o cabeçalho de `lib/schemas/webhooks.ts`).
 *
 * ═══ NENHUM GATILHO INVENTADO ═══
 *
 * Cada entrada aponta para um `event_type` que o produto REALMENTE emite hoje,
 * medido no código antes de escrever esta lista — não para um evento que seria
 * bom existir. Gatilho que aparece na tela e nunca dispara é pior que gatilho
 * ausente: o operador monta o fluxo, liga, e fica esperando. Onde o evento não
 * existia (`contact.tag_removed`), ele foi IMPLEMENTADO junto (migration 0388,
 * no mesmo trigger que já emitia a adição) em vez de a opção ser oferecida a
 * seco.
 *
 * Quem consome: `lib/flows/trigger.handler.ts` (assina `EVENTOS_DE_GATILHO` no
 * dispatcher do event_log) e a tela do seletor.
 */
import type { EventRow } from "@/lib/event-log/dispatcher";

export type FlowTriggerId =
  | "contact_created"
  | "contact_tag_added"
  | "contact_tag_removed"
  | "contact_field_changed"
  | "contact_birthday"
  | "whatsapp_message_received"
  | "lead_created"
  | "lead_stage_changed"
  | "lead_won"
  | "lead_lost"
  | "appointment_created"
  | "appointment_confirmed"
  | "appointment_cancelled"
  | "broadcast";

export type FlowTriggerCategory = "contato" | "whatsapp" | "funil" | "agenda" | "disparo";

/** Campo que a tela pede para ESTE gatilho (vazio = gatilho sem configuração). */
export type FlowTriggerFieldKind = "tag" | "campo" | "etapa";

export interface FlowTriggerDefinition {
  id: FlowTriggerId;
  label: string;
  /** Uma linha, em português de operação — é o que a tela mostra embaixo do nome. */
  description: string;
  category: FlowTriggerCategory;
  /** O(s) `event_log.event_type` REAL que aciona este gatilho. */
  events: string[];
  /** Onde o contato do evento é encontrado: direto, ou pelo negócio/agendamento. */
  entity: "contact" | "crm_lead" | "calendar_appointment" | "message";
  /** Campo de configuração que a tela pede. Ausente = dispara em todo evento do tipo. */
  field?: { kind: FlowTriggerFieldKind; key: string; label: string; placeholder?: string; required: boolean };
  /**
   * O nó de MENSAGEM funciona neste gatilho?
   *
   * Envio automático passa pela fronteira de serviço (`fn_service_event_origin`),
   * que só reconhece evento cuja origem ela sabe carimbar. `lead.won`/`lead.lost`
   * nascem DENTRO do trigger de `crm_leads`, e pôr o carimbo no caminho quente de
   * todo UPDATE de negócio é contenção que esta entrega não mediu — ver o bloco
   * da fronteira na migration 0388. Nesses dois, ação/condição/webhook rodam e a
   * mensagem recusa; a tela avisa ANTES, em vez de deixar o operador montar um
   * fluxo que só falha na hora H. Ausente = suportado.
   */
  mensagemSuportada?: boolean;
  /**
   * Gatilho que ninguém ESCOLHE: ele nasce com o fluxo de um disparo (migration
   * 0399, `flows.broadcast_id`). Fica fora do seletor e da API de fluxos
   * comuns; o banco amarra `broadcast` ⇔ `broadcast_id` (`flows_disparo_coerente`).
   */
  interno?: boolean;
}

export const FLOW_TRIGGERS: Record<FlowTriggerId, FlowTriggerDefinition> = {
  contact_created: {
    id: "contact_created",
    label: "Novo contato criado",
    description: "Sempre que um contato novo entra no CRM — por qualquer porta.",
    category: "contato",
    events: ["contact.created"],
    entity: "contact",
  },
  contact_tag_added: {
    id: "contact_tag_added",
    label: "Tag atribuída ao contato",
    description: "Quando a tag que você escolher for aplicada a um contato.",
    category: "contato",
    events: ["contact.tag_added"],
    entity: "contact",
    field: { kind: "tag", key: "tag", label: "Tag", placeholder: "ONBOARDING", required: true },
  },
  contact_tag_removed: {
    id: "contact_tag_removed",
    label: "Tag removida do contato",
    description: "Quando a tag que você escolher for tirada de um contato.",
    category: "contato",
    events: ["contact.tag_removed"],
    entity: "contact",
    field: { kind: "tag", key: "tag", label: "Tag", placeholder: "ONBOARDING", required: true },
  },
  contact_field_changed: {
    id: "contact_field_changed",
    label: "Valor de um campo do contato mudou",
    description: "Quando o campo que você escolher for alterado (inclusive campo personalizado).",
    category: "contato",
    events: ["contact.updated"],
    entity: "contact",
    field: { kind: "campo", key: "campo", label: "Campo", placeholder: "custom_fields.plano", required: true },
  },
  contact_birthday: {
    id: "contact_birthday",
    label: "Aniversário do contato",
    description: "No dia do aniversário, pela varredura diária que já existe.",
    category: "contato",
    events: ["contact.birthday"],
    entity: "contact",
  },
  whatsapp_message_received: {
    id: "whatsapp_message_received",
    label: "O contato envia uma mensagem",
    description: "Toda mensagem que chega pelo WhatsApp. Sem palavra-chave, dispara em qualquer uma.",
    category: "whatsapp",
    events: ["message.received"],
    entity: "message",
    field: {
      kind: "campo",
      key: "contem",
      label: "Só quando a mensagem contém (opcional)",
      placeholder: "quero comprar",
      required: false,
    },
  },
  lead_created: {
    id: "lead_created",
    label: "Negócio criado no funil",
    description: "Quando um negócio novo nasce em qualquer funil.",
    category: "funil",
    events: ["lead.created"],
    entity: "crm_lead",
  },
  lead_stage_changed: {
    id: "lead_stage_changed",
    label: "Negócio mudou de etapa",
    description: "Quando um negócio entra na etapa que você escolher.",
    category: "funil",
    events: ["lead.stage_changed"],
    entity: "crm_lead",
    field: { kind: "etapa", key: "stage_id", label: "Etapa de destino (opcional)", required: false },
  },
  lead_won: {
    id: "lead_won",
    label: "Negócio ganho",
    description: "Quando um negócio é marcado como ganho. (Sem envio de mensagem — só ações e webhook.)",
    category: "funil",
    events: ["lead.won"],
    entity: "crm_lead",
    mensagemSuportada: false,
  },
  lead_lost: {
    id: "lead_lost",
    label: "Negócio perdido",
    description: "Quando um negócio é marcado como perdido. (Sem envio de mensagem — só ações e webhook.)",
    category: "funil",
    events: ["lead.lost"],
    entity: "crm_lead",
    mensagemSuportada: false,
  },
  appointment_created: {
    id: "appointment_created",
    label: "Agendamento marcado",
    description: "Quando um horário é marcado na Agenda.",
    category: "agenda",
    events: ["appointment.created"],
    entity: "calendar_appointment",
  },
  appointment_confirmed: {
    id: "appointment_confirmed",
    label: "Agendamento confirmado",
    description: "Quando o contato confirma presença.",
    category: "agenda",
    events: ["appointment.confirmed"],
    entity: "calendar_appointment",
  },
  appointment_cancelled: {
    id: "appointment_cancelled",
    label: "Agendamento cancelado",
    description: "Quando um horário é cancelado.",
    category: "agenda",
    events: ["appointment.cancelled"],
    entity: "calendar_appointment",
  },
  broadcast: {
    id: "broadcast",
    label: "O disparo alcança o contato",
    description: "Cada contato do público do disparo entra no fluxo quando o disparo chega a ele, no ritmo do disparo.",
    category: "disparo",
    // Nenhum evento: quem inicia a execução é o worker dos disparos, carregando a
    // permissão que o agendamento materializou (lib/disparos/worker.ts).
    events: [],
    entity: "contact",
    interno: true,
  },
};

export const FLOW_TRIGGER_IDS = Object.keys(FLOW_TRIGGERS) as [FlowTriggerId, ...FlowTriggerId[]];

/** Os gatilhos que uma pessoa ESCOLHE — o catálogo sem os internos (o do disparo). */
export const FLOW_TRIGGER_IDS_ESCOLHIVEIS = FLOW_TRIGGER_IDS.filter((id) => !FLOW_TRIGGERS[id].interno) as [
  FlowTriggerId,
  ...FlowTriggerId[],
];

/**
 * Todo `event_type` que algum gatilho consome — é o que o handler assina no
 * dispatcher. Derivado do catálogo, nunca escrito à mão: gatilho novo entra no
 * handler sem ninguém lembrar (o modo de falha descrito no cabeçalho).
 */
export const EVENTOS_DE_GATILHO = [...new Set(Object.values(FLOW_TRIGGERS).flatMap((t) => t.events))];

export const CATEGORIA_LABEL: Record<FlowTriggerCategory, string> = {
  contato: "Eventos de contato",
  whatsapp: "WhatsApp",
  funil: "Funil de vendas",
  agenda: "Agenda",
  disparo: "Disparo",
};

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

/**
 * Este evento aciona ESTE flow?
 *
 * Função pura, testável sem banco: recebe a linha do evento e a configuração do
 * gatilho, devolve sim/não. É aqui que "a tag do flow" vira só mais um filtro,
 * em vez de ser o conceito inteiro.
 */
export function eventoAcionaGatilho(
  triggerId: string,
  config: Record<string, unknown>,
  row: Pick<EventRow, "event_type" | "payload">,
): boolean {
  const def = FLOW_TRIGGERS[triggerId as FlowTriggerId];
  if (!def) return false;
  if (!def.events.includes(row.event_type)) return false;

  switch (def.id) {
    case "contact_tag_added":
    case "contact_tag_removed": {
      const alvo = texto(config.tag);
      if (!alvo) return false; // tag obrigatória: sem ela o flow não dispara para tudo
      const tag = texto(row.payload.tag);
      if (tag) return tag === alvo;
      // `add_tag` da automação emite a forma plural (`added_tags`).
      const lista = Array.isArray(row.payload.added_tags) ? row.payload.added_tags : [];
      return lista.some((t) => texto(t) === alvo);
    }
    case "contact_field_changed": {
      const alvo = texto(config.campo);
      if (!alvo) return false;
      const campos = Array.isArray(row.payload.fields) ? row.payload.fields : [];
      // `custom_fields.plano` casa tanto com o campo cru quanto com o pai.
      return campos.some((c) => {
        const nome = texto(c);
        return nome === alvo || alvo.startsWith(`${nome}.`);
      });
    }
    case "whatsapp_message_received": {
      const contem = texto(config.contem);
      if (!contem) return true; // sem palavra-chave, toda mensagem serve
      const corpo = texto(row.payload.body_preview) || texto(row.payload.body);
      return corpo.includes(contem);
    }
    case "lead_stage_changed": {
      const alvo = typeof config.stage_id === "string" ? config.stage_id.trim() : "";
      if (!alvo) return true; // sem etapa escolhida, qualquer mudança serve
      const destino = row.payload.to_stage_id ?? row.payload.stage_id;
      return typeof destino === "string" && destino === alvo;
    }
    default:
      return true;
  }
}

/** Como o card do gatilho se descreve no canvas, já com a configuração dele. */
export function resumoDoGatilho(triggerId: string | null | undefined, config: Record<string, unknown> | null | undefined): string {
  // Rascunho que nasceu no construtor (migration 0393): ainda sem gatilho.
  if (!triggerId) return "Sem gatilho — escolha o que inicia este fluxo";
  config = config ?? {};
  const def = FLOW_TRIGGERS[triggerId as FlowTriggerId];
  if (!def) return "Gatilho não reconhecido";
  if (!def.field) return def.label;
  const valor = config[def.field.key];
  if (typeof valor !== "string" || !valor.trim()) {
    return def.field.required ? `${def.label} — falta escolher ${def.field.label.toLowerCase()}` : def.label;
  }
  return `${def.label}: ${valor.trim()}`;
}
