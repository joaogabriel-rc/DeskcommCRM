/**
 * Resolução da sessão dona de um webhook da Meta.
 *
 * Existe porque o `lint-channels` me pegou: a rota `/api/v1/webhooks/meta/[token]`
 * cravava `.eq("provider", "meta_cloud")`, e nome de provider fora de
 * `lib/channels/` viola o invariante 1 da doutrina de restrição de canal.
 *
 * A tentação era pôr a rota na allowlist do lint — afinal, um endpoint de webhook
 * É inerentemente específico do provider (o protocolo da Meta não é o do WAHA).
 * Mas allowlist sem conserto é dívida silenciosa: o nome continuaria espalhado, e a
 * próxima rota copiaria o padrão. Mover a query para cá custa 20 linhas e mantém a
 * regra valendo de verdade — a rota vira transporte puro e não sabe com quem fala.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_META } from "../capabilities";

export interface MetaWebhookSession {
  id: string;
  organizationId: string;
  wabaId: string | null;
}

/**
 * A busca da sessão NÃO aconteceu — o banco não respondeu ou recusou a consulta.
 *
 * É diferente de "não achei", e as duas rotas do webhook dependem dessa
 * diferença: "não achei" é 404 (token velho, canal excluído) e a Meta pode
 * desistir; "não consegui perguntar" é 503 e a Meta TEM de reentregar. Até
 * 06/11/2026 a busca por token devolvia `null` nos dois casos, e uma queda do
 * Supabase de quatro horas virou 2.529 entregas recusadas com "token
 * desconhecido" — os dois tokens eram de sessões ativas.
 *
 * O supabase-js não lança em falha de rede: devolve `{ error }` com a mensagem
 * do `fetch` (ou a página HTML do 522 da Cloudflare). Por isso quem consulta
 * precisa olhar o `error`, e é esta classe que leva a falha até a rota.
 */
export class FalhaAoBuscarSessaoDaMeta extends Error {
  readonly codigo: string;

  constructor(etapa: string, erro: { code?: string | null; message?: string | null } | unknown) {
    const e = (erro ?? {}) as { code?: string | null; message?: string | null };
    const codigo = typeof e.code === "string" && e.code ? e.code : "sem_codigo";
    // A mensagem do banco pode ser a página inteira do 522: corta para o log.
    const detalhe = (typeof e.message === "string" ? e.message : erro instanceof Error ? erro.message : String(erro))
      .replace(/\s+/g, " ")
      .slice(0, 200);
    super(`${etapa}: ${codigo} ${detalhe}`.trim());
    this.name = "FalhaAoBuscarSessaoDaMeta";
    this.codigo = codigo;
  }
}

/**
 * Roda a consulta e transforma QUALQUER falha dela — `{ error }` devolvido ou
 * promessa rejeitada — em `FalhaAoBuscarSessaoDaMeta`. Resultado vazio passa
 * adiante: decidir o que é "não achei" é de quem chamou.
 */
async function consultarOuFalhar<R extends { error: { code?: string | null; message?: string | null } | null }>(
  etapa: string,
  consulta: () => PromiseLike<R>,
): Promise<R> {
  let r: R;
  try {
    r = await consulta();
  } catch (err) {
    throw new FalhaAoBuscarSessaoDaMeta(etapa, err);
  }
  if (r.error) throw new FalhaAoBuscarSessaoDaMeta(etapa, r.error);
  return r;
}

/**
 * A sessão oficial ATIVA da organização **e o número dela**.
 *
 * O par `(organization_id, meta_phone_number_id)` é a chave com que
 * `resolveMetaCreds` acha a credencial que o operador salvou na tela — a mesma porta
 * que `send`, `checkHealth` e `fetchInboundMedia` já usam. Mora aqui, e não na rota,
 * porque nome de provider fora de `lib/channels/` viola o invariante 1 (o
 * `lint-channels` pegou isso uma vez e a lição ficou); e existe como interface
 * própria para não obrigar a sessão do WEBHOOK, que não tem número, a carregar um
 * campo que ela nunca preenche.
 */
export interface MetaSessaoDaOrg extends MetaWebhookSession {
  /** `channel_sessions.meta_phone_number_id` — `null` em base anterior à 0144. */
  phoneNumberId: string | null;
}

/**
 * Sessão amarrada a este token de webhook. `null` = token desconhecido (a rota
 * responde 404 sem revelar por quê). **Lança `FalhaAoBuscarSessaoDaMeta` quando
 * a consulta falha** — a rota responde 503 e a Meta reentrega; responder 404
 * nesse caso diria "este token não existe" sobre um canal ativo.
 *
 * O token no path é o que amarra o payload a UMA organização. O App Secret da Meta
 * é do APP e vale para todas as WABAs de todos os tenants — sozinho, ele autentica
 * a origem mas não decide o destino. Sem o token, quem conhecesse o segredo
 * escreveria em qualquer organização.
 *
 * Canal ARQUIVADO conta como token desconhecido, e essa é a única resposta
 * honesta: o usuário mandou excluir o canal. A exclusão já revoga a credencial e
 * rotaciona este token, mas o evento em voo (e a re-entrega que a plataforma faz
 * de tudo que não recebe 2xx) chegaria com o token antigo e ressuscitaria o
 * canal — criando contato, conversa e mensagem num inbox onde o operador nem
 * consegue responder, porque o arquivamento deixa a sessão STOPPED.
 */
export async function metaSessionByWebhookToken(
  token: string,
): Promise<MetaWebhookSession | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id")
      .eq("webhook_path_token", token)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data } = await consultarOuFalhar("sessao_do_token", () =>
    queryTolerantToMissingArchived(
      () => base().is(ARCHIVED_AT, null).maybeSingle(),
      () => base().maybeSingle(),
    ),
  );

  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
  };
}

type Admin = ReturnType<typeof createAdminClient>;

/** Sem ambiguidade: o que o endpoint universal pode usar, e o que ele NÃO deve adivinhar. */
export type SessaoDoNumero =
  | { encontrada: true; sessao: MetaWebhookSession }
  | { encontrada: false; motivo: "sem_sessao" | "ambigua" };

const ID_DA_META = /^\d{5,25}$/;

/**
 * A sessão oficial ATIVA dona deste `phone_number_id`, em QUALQUER organização —
 * é assim que o endpoint universal descobre o tenant de um evento.
 *
 * Buscar sem filtro de organização é o desenho, não descuido: a organização é o
 * que se quer descobrir, e a fonte é o nosso banco. Só é seguro porque (1) o
 * `phone_number_id` vem de um corpo com assinatura HMAC válida do App Secret da
 * instalação e (2) o índice único parcial da migration 0165 garante no máximo uma
 * sessão ativa por número.
 *
 * `limit(2)` e não `maybeSingle()`: num banco em que o índice não chegou, duas
 * linhas não viram erro nem palpite — viram `ambigua`, e ninguém recebe o evento.
 * **Lança quando a consulta falha**: a rota responde 5xx e a Meta reentrega, em vez
 * de a mensagem se perder com um 200.
 */
export async function metaSessionByPhoneNumberId(admin: Admin, phoneNumberId: string): Promise<SessaoDoNumero> {
  if (!ID_DA_META.test(phoneNumberId)) return { encontrada: false, motivo: "sem_sessao" };
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id")
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data } = await consultarOuFalhar("sessao_do_numero", () =>
    queryTolerantToMissingArchived(
      () => base().is(ARCHIVED_AT, null).limit(2),
      () => base().limit(2),
    ),
  );
  const linhas = (data ?? []) as Array<{ id: string; organization_id: string; meta_waba_id: string | null }>;
  if (linhas.length === 0) return { encontrada: false, motivo: "sem_sessao" };
  if (linhas.length > 1) return { encontrada: false, motivo: "ambigua" };
  const [l] = linhas;
  return { encontrada: true, sessao: { id: l!.id, organizationId: l!.organization_id, wabaId: l!.meta_waba_id ?? null } };
}

/**
 * As sessões oficiais ATIVAS desta WABA — para o evento que não traz número, que é
 * a mudança de estado de um template (`message_template_status_update`). O
 * template é da WABA, e toda organização que tem sessão com ela espelha o mesmo
 * template; por isso é uma LISTA, e cada uma recebe o update escopado a si.
 * Lança quando a consulta falha, pelo mesmo motivo da busca por número.
 */
export async function metaSessionsByWabaId(admin: Admin, wabaId: string): Promise<MetaWebhookSession[]> {
  if (!ID_DA_META.test(wabaId)) return [];
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id")
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_waba_id", wabaId);
  const { data } = await consultarOuFalhar("sessoes_da_waba", () =>
    queryTolerantToMissingArchived(
      () => base().is(ARCHIVED_AT, null),
      () => base(),
    ),
  );
  return ((data ?? []) as Array<{ id: string; organization_id: string; meta_waba_id: string | null }>).map((l) => ({
    id: l.id,
    organizationId: l.organization_id,
    wabaId: l.meta_waba_id ?? null,
  }));
}

/**
 * A sessão oficial ATIVA da organização (se houver). Usada pela tela de templates
 * para saber QUAL WABA espelhar — e para dizer ao operador o que fazer quando não
 * há nenhuma, em vez de mostrar uma tabela vazia sem explicação.
 *
 * Arquivada não conta: sem o filtro, a tela seguia nomeando a WABA de um canal
 * que o operador excluiu e o botão de sincronizar continuava puxando templates
 * dela — o token do env não foi revogado junto com o da linha, então a chamada
 * ia mesmo. "Excluído" que continua operando é a promessa quebrada.
 */
export async function metaSessionForOrg(
  organizationId: string,
): Promise<MetaSessaoDaOrg | null> {
  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      // `meta_phone_number_id` entra na seleção porque é a segunda metade da chave da
      // credencial (`organization_id` + ele): sem o número, quem chama não tem como
      // pedir a credencial DESTA sessão e volta a olhar o ambiente — que é o defeito
      // que a fatia F4 da #850 fecha.
      .select("id, organization_id, meta_waba_id, meta_phone_number_id")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true })
      .limit(1);
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
  };
}
