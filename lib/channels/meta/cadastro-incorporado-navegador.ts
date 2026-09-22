/**
 * Cadastro Incorporado da Meta — o lado do NAVEGADOR. Seguro para o cliente: não
 * importa nada de servidor e não vê segredo nenhum (só App ID e Configuration ID,
 * que são identificadores públicos do app, entregues pelo `<PublicEnvScript/>`).
 *
 * O que se decide aqui é o que o navegador ACEITA ouvir. A mensagem
 * `WA_EMBEDDED_SIGNUP` chega por `postMessage`, e `postMessage` qualquer janela
 * manda: a origem é conferida contra uma lista EXATA — o exemplo da Meta usa
 * `endsWith('facebook.com')`, que aceitaria `evilfacebook.com`. E mesmo aceita, a
 * mensagem é só sugestão: o servidor confirma tudo com a Meta.
 */

export const URL_DO_SDK_DA_META = "https://connect.facebook.net/en_US/sdk.js";

/** Janelas da Meta que abrem o fluxo. Qualquer outra origem é ignorada. */
export const ORIGENS_DA_META: ReadonlySet<string> = new Set([
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
]);

export const EVENTOS_DE_CONCLUSAO = [
  "FINISH",
  "FINISH_ONLY_WABA",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
  "FINISH_GRANT_ONLY_API_ACCESS",
] as const;

export type EventoDeConclusao = (typeof EVENTOS_DE_CONCLUSAO)[number];

export type MensagemDoCadastro =
  | { tipo: "concluido"; evento: EventoDeConclusao; wabaId?: string; phoneNumberId?: string }
  | { tipo: "cancelado"; passo?: string }
  | { tipo: "erro"; codigo?: string };

const ID_DA_META = /^\d{5,25}$/;

function id(v: unknown): string | undefined {
  return typeof v === "string" && ID_DA_META.test(v) ? v : undefined;
}

function curto(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 80) : undefined;
}

export function origemDaMetaAceita(origem: string): boolean {
  return ORIGENS_DA_META.has(origem);
}

/**
 * Lê uma mensagem recebida pela janela. `null` para tudo que não for uma mensagem
 * de cadastro válida vinda da Meta — inclusive as mensagens internas do SDK, que
 * podem carregar o code e nunca devem ser tratadas como dado.
 *
 * O erro do fluxo chega como `event: "CANCEL"` com `error_message` (é o formato
 * documentado da v4); `"ERROR"` também é aceito, caso a Meta volte a usá-lo.
 */
export function lerMensagemDoCadastro(origem: string, dado: unknown): MensagemDoCadastro | null {
  if (!origemDaMetaAceita(origem)) return null;

  let obj: unknown = dado;
  if (typeof dado === "string") {
    try {
      obj = JSON.parse(dado);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const m = obj as { type?: unknown; event?: unknown; data?: unknown };
  if (m.type !== "WA_EMBEDDED_SIGNUP" || typeof m.event !== "string") return null;
  const data = (m.data && typeof m.data === "object" ? m.data : {}) as Record<string, unknown>;

  if ((EVENTOS_DE_CONCLUSAO as readonly string[]).includes(m.event)) {
    return {
      tipo: "concluido",
      evento: m.event as EventoDeConclusao,
      wabaId: id(data.waba_id),
      phoneNumberId: id(data.phone_number_id),
    };
  }
  if (m.event === "ERROR" || (m.event === "CANCEL" && (data.error_message || data.error_code))) {
    return { tipo: "erro", codigo: curto(data.error_code) };
  }
  if (m.event === "CANCEL") return { tipo: "cancelado", passo: curto(data.current_step) };
  return null;
}

/** App ID e Configuration ID em vigor, lidos do `<PublicEnvScript/>`. `null` = indisponível. */
export function configPublicaDoCadastro(): { appId: string; configId: string } | null {
  if (typeof window === "undefined") return null;
  const appId = window.__PUBLIC_ENV__?.META_APP_ID?.trim() ?? "";
  const configId = window.__PUBLIC_ENV__?.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim() ?? "";
  return ID_DA_META.test(appId) && ID_DA_META.test(configId) ? { appId, configId } : null;
}

// ─── SDK ────────────────────────────────────────────────────────────────────

export interface RespostaDoLogin {
  status?: string;
  authResponse?: { code?: string } | null;
}

export interface SdkDaMeta {
  init(opcoes: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(callback: (resposta: RespostaDoLogin) => void, opcoes: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: SdkDaMeta;
    fbAsyncInit?: () => void;
  }
}

let carregamento: Promise<SdkDaMeta> | null = null;

/**
 * Carrega o SDK uma vez por página. Bloqueador de anúncio costuma barrar
 * `connect.facebook.net` sem erro nenhum — daí o prazo: sem ele o botão ficaria
 * em "preparando" para sempre.
 */
export function carregarSdkDaMeta(appId: string, versao: string, prazoMs = 15_000): Promise<SdkDaMeta> {
  if (carregamento) return carregamento;
  carregamento = new Promise<SdkDaMeta>((resolve, reject) => {
    const iniciar = (sdk: SdkDaMeta) => {
      sdk.init({ appId, autoLogAppEvents: true, xfbml: false, version: versao });
      resolve(sdk);
    };
    if (window.FB) return iniciar(window.FB);

    const prazo = window.setTimeout(() => {
      carregamento = null;
      reject(new Error("sdk_indisponivel"));
    }, prazoMs);
    window.fbAsyncInit = () => {
      window.clearTimeout(prazo);
      if (window.FB) iniciar(window.FB);
    };
    const script = document.createElement("script");
    script.src = URL_DO_SDK_DA_META;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      window.clearTimeout(prazo);
      carregamento = null;
      reject(new Error("sdk_indisponivel"));
    };
    document.body.appendChild(script);
  });
  return carregamento;
}

/**
 * Abre o fluxo. SÍNCRONO de propósito: chamado dentro do clique, sem nenhum
 * `await` antes — senão o navegador trata o popup como não solicitado e o bloqueia.
 * O callback também é uma função comum: o SDK recusa função `async`.
 *
 * `extras.setup` vazio, sem `sessionInfoVersion` nem `featureType`: na v4 quem
 * escolhe produtos e versão é a configuração do Facebook Login for Business.
 */
export function abrirCadastroDaMeta(
  sdk: SdkDaMeta,
  configId: string,
  aoVoltar: (resposta: RespostaDoLogin) => void,
): void {
  sdk.login(
    function (resposta) {
      aoVoltar(resposta);
    },
    {
      config_id: configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    },
  );
}
