/**
 * A BIBLIOTECA DE AÇÕES — "Realize as seguintes ações…".
 *
 * Catálogo declarativo do que o nó ACTION oferece na tela, por categoria.
 * Cada entrada aponta para um executor REAL registrado em
 * `lib/automation/actions/*` — os mesmos que a automação de regras usa. Ação
 * nova é um executor lá + uma entrada aqui; nada de terceira lista.
 *
 * `campos` descreve o formulário sem que a tela precise de um `switch` por
 * tipo: o painel do nó renderiza a partir daqui, então ação nova aparece
 * configurável sem tocar em componente.
 */
/**
 * `campo` (o seletor de campo do contato) e `tags` (o seletor de etiqueta)
 * leem os REGISTROS da organização (migration 0383) em vez de aceitarem texto
 * solto. Antes disso a chave do campo era DIGITADA no painel, e um erro de
 * digitação gravava um campo fantasma que a mensagem seguinte renderizava
 * vazio — sem erro em lugar nenhum, porque gravar `custom_fields.prduto` é uma
 * escrita perfeitamente válida num jsonb.
 */
export type CampoDeAcaoKind =
  | "tags"
  | "campo"
  | "texto"
  | "usuario"
  | "funil"
  | "etapa"
  | "flow"
  | "url"
  | "segredo";

export interface CampoDeAcao {
  key: string;
  label: string;
  kind: CampoDeAcaoKind;
  placeholder?: string;
  required: boolean;
  /** Dica curta embaixo do campo, quando a escolha tem consequência. */
  ajuda?: string;
}

export type CategoriaDeAcao = "contato" | "conversa" | "automacao" | "integracao";

export interface DefinicaoDeAcao {
  /** O `type` do executor registrado em lib/automation/actions. */
  type: string;
  label: string;
  descricao: string;
  categoria: CategoriaDeAcao;
  campos: CampoDeAcao[];
}

export const CATEGORIA_DE_ACAO_LABEL: Record<CategoriaDeAcao, string> = {
  contato: "Dados do contato",
  conversa: "Conversa",
  automacao: "Automação",
  integracao: "Integração",
};

export const ACOES_DO_FLOW: DefinicaoDeAcao[] = [
  {
    type: "add_tag",
    label: "Adicionar tag",
    descricao: "Marca o contato para organizar e segmentar — e pode disparar outro flow.",
    categoria: "contato",
    campos: [{ key: "tags", label: "Tags", kind: "tags", placeholder: "CLIENTE, VIP", required: true }],
  },
  {
    type: "remove_tag",
    label: "Remover tag",
    descricao: "Tira a marcação quando ela não vale mais.",
    categoria: "contato",
    campos: [{ key: "tags", label: "Tags", kind: "tags", placeholder: "LEAD_FRIO", required: true }],
  },
  {
    type: "update_custom_field",
    label: "Definir campo do usuário",
    descricao: "Guarda um valor no contato para usar depois em mensagens, condições e segmentações.",
    categoria: "contato",
    campos: [
      { key: "field", label: "Campo", kind: "campo", required: true },
      {
        key: "value",
        label: "Valor",
        kind: "texto",
        placeholder: "Impressão 3D",
        required: true,
        ajuda: "Aceita variáveis: {{contact.name}}, {{contact.custom_fields.outro_campo}}.",
      },
    ],
  },
  {
    type: "clear_custom_field",
    label: "Limpar campo do usuário",
    descricao: "Apaga o valor guardado nesse campo.",
    categoria: "contato",
    campos: [{ key: "field", label: "Campo", kind: "campo", required: true }],
  },
  {
    type: "assign_owner",
    label: "Atribuir responsável pelo negócio",
    descricao: "Define quem cuida do negócio do contato no funil.",
    categoria: "contato",
    campos: [{ key: "user_id", label: "Pessoa do time", kind: "usuario", required: true }],
  },
  {
    type: "create_or_move_lead",
    label: "Mover para uma etapa do funil",
    descricao: "Leva o negócio do contato para a etapa escolhida — e cria o negócio se ainda não existir.",
    categoria: "contato",
    campos: [
      { key: "pipeline_id", label: "Funil", kind: "funil", required: true },
      { key: "stage_id", label: "Etapa", kind: "etapa", required: true },
    ],
  },
  {
    type: "mark_conversation_open",
    label: "Marcar conversa como aberta",
    descricao: "Sinaliza que o atendimento está em andamento.",
    categoria: "conversa",
    campos: [],
  },
  {
    type: "assign_conversation",
    label: "Atribuir conversa",
    descricao: "Entrega a conversa a alguém do time.",
    categoria: "conversa",
    campos: [{ key: "user_id", label: "Pessoa do time", kind: "usuario", required: true }],
  },
  {
    type: "start_flow",
    label: "Iniciar outro flow",
    descricao: "Manda o contato para outro fluxo ativo.",
    categoria: "automacao",
    campos: [{ key: "flow_id", label: "Flow", kind: "flow", required: true }],
  },
  {
    type: "stop_flow",
    label: "Parar flow",
    descricao: "Cancela o que estiver em andamento para este contato.",
    categoria: "automacao",
    campos: [
      {
        key: "flow_id",
        label: "Flow (vazio = todos)",
        kind: "flow",
        required: false,
        ajuda: "Deixe vazio para parar qualquer fluxo em andamento deste contato.",
      },
    ],
  },
  {
    type: "call_webhook",
    label: "Fazer uma consulta externa",
    descricao: "Envia os dados do contato para o seu servidor ou para o N8N.",
    categoria: "integracao",
    campos: [
      { key: "url", label: "URL", kind: "url", placeholder: "https://…", required: true },
      {
        key: "secret",
        label: "Segredo HMAC (opcional)",
        kind: "segredo",
        required: false,
        ajuda: "Assina o corpo enviado, para o outro lado conferir que veio daqui.",
      },
    ],
  },
];

export function acaoPorTipo(type: string | undefined): DefinicaoDeAcao | undefined {
  return ACOES_DO_FLOW.find((a) => a.type === type);
}

/**
 * Normaliza as DUAS formas de configuração do nó ACTION numa lista só.
 *
 * ⚠️ MORA AQUI, e não em `lib/flows/nodes/action.ts`, por uma razão de BUNDLE,
 * não de organização: aquele arquivo importa
 * `@/lib/automation/actions/register-all`, que arrasta o registry inteiro de
 * executores — e com ele os clients de Supabase e o caminho de envio. O canvas
 * (`nodeVisuals.ts`) e o painel de configuração são componentes de CLIENTE e
 * precisam desta função para desenhar o resumo do nó; importá-la de lá mandaria
 * o motor inteiro para o JavaScript do browser.
 *
 * Este arquivo é catálogo puro: só dados e funções sobre dados.
 *
 * A primeira versão do nó guardava uma ação só, em `action_type` + `config`, e
 * há flows salvos assim no banco de quem já está usando. Migrar esses jsonb por
 * SQL seria reescrever configuração de usuário para conveniência do código;
 * lê-los aqui custa quatro linhas e nunca desatualiza.
 */
export function acoesDoNo(config: {
  actions?: Array<{ action_type: string; config?: Record<string, unknown> }>;
  action_type?: string;
  config?: Record<string, unknown>;
}): Array<{ action_type: string; config?: Record<string, unknown> }> {
  if (Array.isArray(config.actions) && config.actions.length > 0) {
    return config.actions.filter((a) => a && typeof a.action_type === "string" && a.action_type);
  }
  if (config.action_type) return [{ action_type: config.action_type, config: config.config ?? {} }];
  return [];
}
