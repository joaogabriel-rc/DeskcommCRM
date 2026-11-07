/**
 * A falha do banco passa se a mesma escrita for tentada de novo?
 *
 * É a pergunta que decide a resposta de um webhook depois que a sessão já foi
 * achada. A plataforma reentrega tudo que não recebe 2xx, e isso só ajuda
 * quando a causa é passageira. Responder 2xx a uma falha passageira é perder a
 * mensagem (em 06/11/2026 o Supabase ficou quatro horas fora); responder 5xx a
 * uma falha permanente é a plataforma insistir, por dias, num corpo que nunca
 * vai entrar.
 *
 * ─── A regra é LISTA DO QUE É PASSAGEIRO, não lista do que é permanente ──────
 * Uma versão anterior tratava como permanente só 22xxx/23xxx e todo o resto
 * como passageiro — inclusive 42P01 (tabela não existe), 42703 (coluna não
 * existe) e os erros de schema e de JWT do PostgREST. Isso transforma erro de
 * schema ou de configuração em reentrega sem fim. Agora:
 *
 *   - PASSAGEIRA (5xx): o pedido não chegou a uma resposta do Postgres (sem
 *     código: `fetch failed`, `ECONNRESET`, página 522 da Cloudflare); conexão
 *     (08xxx); recurso esgotado (53xxx: conexões, memória, disco); intervenção
 *     do operador (57xxx: timeout de comando 57014, desligamento, "ainda
 *     subindo"); conflito de concorrência (40001, 40P01, 55P03); banco em modo
 *     somente leitura (25006 — o Supabase faz isso com o disco cheio); falha de
 *     E/S do sistema (58000, 58030); e o PostgREST sem conseguir falar com o
 *     banco (PGRST000–PGRST003).
 *
 *   - PERMANENTE (2xx na ingestão, com o motivo no log): todo o resto. Isso
 *     inclui 42xxx (estrutura: tabela, coluna ou função inexistente, permissão),
 *     22xxx/23xxx (dado inválido, integridade), os demais PGRST (requisição
 *     malformada, schema cache sem a tabela/coluna — PGRST204/205 —, JWT
 *     inválido — PGRST3xx) e qualquer SQLSTATE que não esteja na lista acima.
 *
 * `23505` (unique) não chega aqui: no webhook ele é a reentrega de algo que já
 * entrou, e quem chama trata como `duplicate` antes de perguntar.
 *
 * Erro sem código é passageiro de propósito: é a forma como o supabase-js
 * entrega a falha de rede (ele não lança). Erro COM código que ninguém listou é
 * permanente de propósito: um código novo tem de ser decidido, não herdar
 * reentrega por omissão.
 */
export interface ErroDoBancoLike {
  code?: string | null;
  message?: string | null;
}

/** Classes SQLSTATE inteiras que descrevem indisponibilidade, nunca o dado. */
const CLASSES_PASSAGEIRAS = new Set(["08", "53", "57"]);

/** Códigos avulsos passageiros, de classes que também têm códigos permanentes. */
const CODIGOS_PASSAGEIROS = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "25006", // read_only_sql_transaction (banco em somente leitura, p.ex. disco cheio)
  "58000", // system_error
  "58030", // io_error
]);

/** PostgREST sem conseguir conexão com o banco (respostas 503/504). */
const POSTGREST_PASSAGEIROS = new Set([
  "PGRST000", // não conectou ao banco
  "PGRST001", // não conectou por erro interno
  "PGRST002", // não conectou ao montar o schema cache
  "PGRST003", // tempo esgotado esperando conexão do pool
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;
const POSTGREST = /^PGRST/;

export function ehFalhaTransitoriaDoBanco(erro: ErroDoBancoLike | null | undefined): boolean {
  if (!erro) return false;
  const codigo = typeof erro.code === "string" ? erro.code.trim().toUpperCase() : "";

  if (POSTGREST.test(codigo)) return POSTGREST_PASSAGEIROS.has(codigo);
  // Sem código de banco = o pedido não teve resposta do Postgres (rede, proxy,
  // HTML de erro). Inclui os códigos do Node (`ECONNRESET`, `ETIMEDOUT`).
  if (!SQLSTATE.test(codigo)) return true;
  return CLASSES_PASSAGEIRAS.has(codigo.slice(0, 2)) || CODIGOS_PASSAGEIROS.has(codigo);
}

/**
 * A ingestão falhou SEM gravar, por causa que a reentrega pode resolver — o
 * desfecho `{ status: "failed", retentavel: true }` dos ingestores.
 */
export function ingestaoPedeReentrega(o: { status: string; retentavel?: boolean }): boolean {
  return o.status === "failed" && o.retentavel === true;
}
