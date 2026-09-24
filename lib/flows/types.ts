import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { EventRow } from "@/lib/event-log/dispatcher";

/**
 * Os tipos de PASSO do flow.
 *
 * `TRIGGER` é o nó de entrada e guarda QUAL gatilho o flow escuta (catálogo em
 * `lib/flows/triggers.ts`) — tag é apenas um deles. Os botões não são um tipo
 * de nó: eles são SAÍDAS do nó `MESSAGE`, como na referência de mercado.
 */
export const FLOW_NODE_TYPES = [
  "TRIGGER",
  "MESSAGE",
  "CONDITION",
  "ACTION",
  "DELAY",
  "WEBHOOK",
  "END",
] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  type: FlowNodeType;
  label: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

export interface FlowEdgeRow {
  id: string;
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  source_handle: string | null;
}

export type FlowExecutionStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type FlowWaitingFor = "button_reply" | "delay";

export interface FlowExecutionRow {
  id: string;
  organization_id: string;
  flow_id: string;
  contact_id: string;
  conversation_id: string | null;
  status: FlowExecutionStatus;
  current_node_id: string | null;
  waiting_for: FlowWaitingFor | null;
  waiting_node_id: string | null;
  context: Record<string, unknown>;
  trigger_event_id: string | null;
  next_execution_at: string | null;
  attempts: number;
  last_error: string | null;
  /**
   * A permissão de envio que o DISPARO materializou no agendamento
   * (`broadcast_recipients.service_boundary`), carregada pela execução até o
   * nó de mensagem (migration 0399). Nula na execução iniciada por evento — lá a
   * permissão sai do evento (`serviceForAutomation`).
   */
  service_boundary?: unknown;
  /** O destinatário do disparo que iniciou esta execução (0399). */
  broadcast_recipient_id?: string | null;
}

/**
 * Contexto de execução de um nó — compatível de propósito com `ActionCtx`
 * (lib/automation/types.ts): o nó ACTION reusa `getAction(type).execute(...)`
 * do motor de automação sem duplicar add_tag/assign_owner/create_or_move_lead,
 * e o nó MESSAGE reusa `serviceForAutomation` para resolver a conversa.
 * `ruleId` carrega o id da EXECUÇÃO (não de uma automation_rule) — é só o nome
 * do campo que essas funções esperam.
 */
export interface FlowNodeCtx {
  admin: SupabaseClient;
  organizationId: string;
  ruleId: string;
  ruleName: string;
  event: EventRow;
  context: Record<string, unknown>;
  requestId: string;
  serviceBoundaries: Map<string, Promise<ServiceBoundary>>;
  /**
   * Execução iniciada por um DISPARO: a permissão já autorizada no clique de
   * "Agendar". Presente, o nó de mensagem a usa (reconferida) em vez de
   * derivar uma do evento — um disparo não nasce de evento.
   */
  servicoAutorizado?: ServiceBoundary | null;
}

export type NodeOutcome =
  | { kind: "advance"; handle?: string | null }
  | { kind: "wait_button" }
  | { kind: "wait_delay"; until: string }
  | { kind: "end" }
  | { kind: "failed"; error: string };

export interface TriggerNodeConfig {
  /** Ausente/nulo = rascunho cujo gatilho ainda não foi escolhido (migration 0393). */
  trigger_type?: string | null;
  config?: Record<string, unknown>;
}

export interface MessageButton {
  label: string;
}

/**
 * A JANELA DE 24 HORAS não é detalhe de UI: é a regra da plataforma.
 *
 * `inside_24h` manda texto livre — só vale se a conversa está aberta (o
 * contato falou nas últimas 24h). `outside_24h` manda TEMPLATE aprovado, o
 * único caminho que a plataforma aceita fora da janela, e exige o canal
 * oficial configurado. O motor não finge: escolher `outside_24h` sem template
 * recusa o nó, e template no canal errado falha com o motivo real do provedor.
 */
export type MessageWindowMode = "inside_24h" | "outside_24h";

/**
 * ── O modelo aprovado: referência + retrato ─────────────────────────────────
 *
 * `template_id` é o id da linha do catálogo (`lib/channels/catalogo-de-modelos.ts`)
 * e é a REFERÊNCIA: sobrevive ao sync. `template_name`/`template_language` são o
 * RETRATO — a chave que a plataforma usa no envio, e o que o motor manda. Nó
 * anterior ao seletor guarda só o retrato; o catálogo o resolve por nome e idioma
 * (compatibilidade), e o motor continua enviando por ele sem mudança.
 *
 * `template_contract_hash` é o contrato no instante da escolha. Comparado com o
 * atual (`bindingState`), diz se o modelo MUDOU na plataforma depois de
 * configurado — o caso que `conferirDefinicao` declara não conseguir ver.
 *
 * Com modelo escolhido, `buttons` é DERIVADO dele: as respostas rápidas do
 * modelo, na ordem da plataforma, viram as saídas `button:<i>` do nó. O motor
 * não distingue — casa a resposta pelo mesmo `casarRespostaDeBotao`.
 */
export interface MessageNodeConfig {
  body?: string;
  buttons?: MessageButton[];
  window_mode?: MessageWindowMode;
  template_id?: string;
  template_name?: string;
  template_language?: string;
  template_contract_hash?: string;
  template_values?: Record<string, string>;
  channel_session_id?: string;
}

export interface ConditionNodeConfig {
  // Reusa o mesmo shape/avaliador do motor de automação (lib/automation/conditions.ts):
  // AND entre os checks, resolveField navega dot-path no `context` do nó (contact.*).
  checks?: import("@/lib/automation/conditions").RuleCondition[];
}

/** Uma ação dentro do nó: o `type` do executor + a configuração dele. */
export interface AcaoConfigurada {
  action_type: string;
  config?: Record<string, unknown>;
}

/**
 * O nó ACTION guarda uma LISTA de ações, executadas na ORDEM configurada.
 *
 * ── Por que lista, e não um nó por ação ─────────────────────────────────────
 *
 * Porque "definir dois campos e marcar uma tag" é UM passo na cabeça de quem
 * monta — três nós na tela para uma decisão só enchem o canvas de caixas que
 * não abrem caminho nenhum. E porque a ordem importa: a mensagem seguinte lê
 * `{{contact.custom_fields.x}}`, e o valor só está lá se a ação que o gravou
 * rodou antes. Dentro de um nó a ordem é explícita e visível; espalhada em
 * nós ligados por aresta ela depende de o desenho estar certo.
 *
 * ── `action_type`/`config` no singular continuam aqui, e por quê ────────────
 *
 * São o formato da primeira versão, e há flows salvos com ele no banco de quem
 * já está usando. `acoesDoNo()` (lib/flows/nodes/action.ts) normaliza os dois
 * numa lista só — o motor não conhece duas formas, só a borda conhece.
 */
export interface ActionNodeConfig {
  actions?: AcaoConfigurada[];
  /** @deprecated Formato da primeira versão. Lido por `acoesDoNo()`, nunca escrito. */
  action_type?: string;
  /** @deprecated Ver `action_type`. */
  config?: Record<string, unknown>;
}

export interface DelayNodeConfig {
  duration_ms?: number;
}

export interface WebhookNodeConfig {
  url?: string;
  secret?: string;
}
