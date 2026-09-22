/**
 * Cadastro Incorporado da Meta (Embedded Signup v4) — o lado do SERVIDOR.
 *
 * O navegador só entrega o authorization code (validade de 30 s, uso único). O
 * resto acontece aqui: trocar o code pelo token de integração do negócio do
 * cliente, perguntar à Meta a QUE esse token dá acesso e, a partir disso, escolher
 * a WABA e o número. O que o navegador diz sobre WABA e número (a mensagem
 * `WA_EMBEDDED_SIGNUP`) é SUGESTÃO: passa pelo navegador, então qualquer um a
 * forja — só vale se a Meta confirmar.
 *
 * ─── Nada sensível sai daqui ────────────────────────────────────────────────
 * A troca do code é um GET com `client_secret` e `code` na query (é o contrato
 * documentado pela Meta), e o `debug_token` leva o token em `input_token`. Por
 * isso nenhuma URL deste módulo é logada nem devolvida: o que sobe para quem chama
 * é um motivo classificado e, para diagnóstico, só códigos numéricos e o
 * `fbtrace_id` da Meta — nunca a mensagem crua, que pode ecoar o que recebeu.
 */
import { appDaMeta } from "@/lib/channels/meta/app";
import { metaGraphBase } from "@/lib/channels/meta/credentials";
import { env } from "@/lib/env";
import { graphVersion } from "@/lib/graph-version";

/** Eventos que esta versão NÃO conecta: exigem sincronização/migração que o ingest não faz. */
export const EVENTOS_NAO_SUPORTADOS = new Set([
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
]);

const ID_DA_META = /^\d{5,25}$/;

export type FalhaDoCadastro =
  | "code_expirado"
  | "code_usado"
  | "code_invalido"
  | "app_recusado"
  | "meta_indisponivel"
  | "token_invalido"
  | "token_de_outro_app"
  | "waba_nao_encontrada"
  | "waba_ambigua"
  | "waba_nao_autorizada"
  | "numero_nao_encontrado"
  | "numero_ambiguo"
  | "numero_nao_pertence";

/** O que pode ir para log sobre uma resposta de erro da Meta. */
export interface ErroDaMeta {
  status: number;
  code?: number;
  subcode?: number;
  tipo?: string;
  fbtraceId?: string;
}

export type Falha = { ok: false; motivo: FalhaDoCadastro; erro?: ErroDaMeta };

export interface AppDoCadastro {
  appId: string;
  appSecret: string;
}

// ─── Configuração ───────────────────────────────────────────────────────────

/**
 * O que falta para oferecer o fluxo nesta instalação — sem segredo nenhum, para a
 * tela. Nunca lança: `appDaMeta()` degrada sozinha para o `.env`.
 */
export async function disponibilidadeDoCadastroIncorporado(): Promise<
  | { disponivel: true; versaoDaGraph: string }
  | { disponivel: false; faltando: string[]; versaoDaGraph: string }
> {
  const faltando: string[] = [];
  if (!ID_DA_META.test(env.META_APP_ID.trim())) faltando.push("META_APP_ID");
  if (!ID_DA_META.test(env.META_EMBEDDED_SIGNUP_CONFIG_ID.trim())) {
    faltando.push("META_EMBEDDED_SIGNUP_CONFIG_ID");
  }
  const { appSecret } = await appDaMeta();
  if (!appSecret) faltando.push("META_APP_SECRET");
  const versaoDaGraph = graphVersion();
  return faltando.length ? { disponivel: false, faltando, versaoDaGraph } : { disponivel: true, versaoDaGraph };
}

/** App ID + App Secret para falar com a Meta em nome do app. `null` = indisponível. */
export async function appDoCadastro(): Promise<AppDoCadastro | null> {
  const appId = env.META_APP_ID.trim();
  if (!ID_DA_META.test(appId)) return null;
  const { appSecret } = await appDaMeta();
  return appSecret ? { appId, appSecret } : null;
}

// ─── Chamadas à Graph API ───────────────────────────────────────────────────

interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

async function chamar(url: URL, bearer?: string): Promise<Resposta> {
  try {
    const res = await fetch(url, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined);
    const corpo = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, corpo };
  } catch {
    // A mensagem do erro de rede pode carregar a URL — e a URL leva o segredo.
    return { status: 0, corpo: {} };
  }
}

function erroDa(r: Resposta): ErroDaMeta {
  const e = (r.corpo.error ?? {}) as Record<string, unknown>;
  return {
    status: r.status,
    code: typeof e.code === "number" ? e.code : undefined,
    subcode: typeof e.error_subcode === "number" ? e.error_subcode : undefined,
    tipo: typeof e.type === "string" ? e.type : undefined,
    fbtraceId: typeof e.fbtrace_id === "string" ? e.fbtrace_id : undefined,
  };
}

function metaFora(r: Resposta): boolean {
  return r.status === 0 || r.status >= 500;
}

/**
 * O motivo de uma troca recusada. Só a MENSAGEM distingue "expirado" de "já
 * usado" com segurança entre versões da Graph; os subcódigos 36007/36009 entram
 * como atalho quando a Meta os manda.
 */
function motivoDaTroca(r: Resposta): FalhaDoCadastro {
  if (metaFora(r)) return "meta_indisponivel";
  const e = (r.corpo.error ?? {}) as { message?: unknown; error_subcode?: unknown };
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (e.error_subcode === 36007 || msg.includes("expired")) return "code_expirado";
  if (e.error_subcode === 36009 || msg.includes("been used") || msg.includes("already used")) return "code_usado";
  if (/client[ _](secret|id)/.test(msg)) return "app_recusado";
  return "code_invalido";
}

/**
 * Troca o authorization code pelo token de integração do negócio do cliente.
 *
 * `GET /oauth/access_token` com `client_id`, `client_secret` e `code`, sem
 * `redirect_uri` — é o contrato do fluxo aberto pelo SDK com `config_id`.
 */
export async function trocarCodigoPorToken(
  code: string,
  app: AppDoCadastro,
): Promise<{ ok: true; token: string } | Falha> {
  const url = new URL(`${metaGraphBase()}/oauth/access_token`);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("client_secret", app.appSecret);
  url.searchParams.set("code", code);

  const r = await chamar(url);
  const token = r.corpo.access_token;
  if (r.status === 200 && typeof token === "string" && token.length > 0) return { ok: true, token };
  return { ok: false, motivo: motivoDaTroca(r), erro: erroDa(r) };
}

export interface InspecaoDoToken {
  /** ISO, ou `null` quando a Meta diz que não expira (`expires_at: 0`). */
  expiraEm: string | null;
  /** WABAs a que o token dá acesso de gestão — a lista em que a sugestão tem de estar. */
  wabasAutorizadas: string[];
}

/**
 * Pergunta à Meta o que o token é: se vale, se é DESTE app, quando expira e a que
 * WABAs dá acesso. Autenticado com o app token (`id|segredo`) no cabeçalho.
 */
export async function inspecionarToken(
  token: string,
  app: AppDoCadastro,
): Promise<({ ok: true } & InspecaoDoToken) | Falha> {
  const url = new URL(`${metaGraphBase()}/debug_token`);
  url.searchParams.set("input_token", token);
  const r = await chamar(url, `${app.appId}|${app.appSecret}`);
  if (r.status !== 200) {
    return { ok: false, motivo: metaFora(r) ? "meta_indisponivel" : "token_invalido", erro: erroDa(r) };
  }

  const d = (r.corpo.data ?? {}) as Record<string, unknown>;
  if (d.is_valid !== true) return { ok: false, motivo: "token_invalido" };
  if (String(d.app_id ?? "") !== app.appId) return { ok: false, motivo: "token_de_outro_app" };

  const expira = typeof d.expires_at === "number" ? d.expires_at : 0;
  const escopos = Array.isArray(d.granular_scopes)
    ? (d.granular_scopes as Array<{ scope?: unknown; target_ids?: unknown }>)
    : [];
  const gestao = escopos.find((e) => e.scope === "whatsapp_business_management");
  const alvos = Array.isArray(gestao?.target_ids) ? gestao.target_ids : [];

  return {
    ok: true,
    expiraEm: expira > 0 ? new Date(expira * 1000).toISOString() : null,
    wabasAutorizadas: alvos.map(String).filter((id) => ID_DA_META.test(id)),
  };
}

export interface Sugestao {
  wabaId?: string;
  phoneNumberId?: string;
}

/**
 * Escolhe a WABA e o número que serão conectados.
 *
 * WABA: a sugerida, SE estiver entre as autorizadas pelo token; sem sugestão, a
 * única autorizada. Várias sem sugestão é ambíguo — escolher a errada conectaria
 * um número de outra conta do mesmo negócio.
 *
 * Número: o sugerido, SE estiver na lista de números da WABA escolhida; sem
 * sugestão (o evento de conta já existente não traz número), o único da WABA.
 */
export async function descobrirCanal(
  token: string,
  wabasAutorizadas: readonly string[],
  sugestao: Sugestao,
): Promise<{ ok: true; wabaId: string; phoneNumberId: string } | Falha> {
  let wabaId: string;
  if (sugestao.wabaId) {
    if (!wabasAutorizadas.includes(sugestao.wabaId)) return { ok: false, motivo: "waba_nao_autorizada" };
    wabaId = sugestao.wabaId;
  } else if (wabasAutorizadas.length === 1) {
    wabaId = wabasAutorizadas[0]!;
  } else {
    return { ok: false, motivo: wabasAutorizadas.length === 0 ? "waba_nao_encontrada" : "waba_ambigua" };
  }

  const url = new URL(`${metaGraphBase()}/${wabaId}/phone_numbers`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", "200");
  const r = await chamar(url, token);
  if (r.status !== 200) {
    return { ok: false, motivo: metaFora(r) ? "meta_indisponivel" : "waba_nao_encontrada", erro: erroDa(r) };
  }
  const numeros = (Array.isArray(r.corpo.data) ? (r.corpo.data as Array<{ id?: unknown }>) : [])
    .map((n) => String(n.id ?? ""))
    .filter((id) => ID_DA_META.test(id));

  if (sugestao.phoneNumberId) {
    if (!numeros.includes(sugestao.phoneNumberId)) return { ok: false, motivo: "numero_nao_pertence" };
    return { ok: true, wabaId, phoneNumberId: sugestao.phoneNumberId };
  }
  if (numeros.length === 1) return { ok: true, wabaId, phoneNumberId: numeros[0]! };
  return { ok: false, motivo: numeros.length === 0 ? "numero_nao_encontrado" : "numero_ambiguo" };
}
