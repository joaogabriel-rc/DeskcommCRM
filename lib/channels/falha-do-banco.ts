/**
 * QUAL É A NATUREZA DE UMA FALHA DO BANCO — e o que o webhook responde por ela.
 *
 * Depois que a sessão foi achada, um evento que não foi gravado cai numa de três
 * classes, e cada uma pede uma resposta diferente à plataforma (que reentrega
 * tudo que não recebe 2xx — a Meta, por até 7 dias):
 *
 *   - `transitoria` — a INFRAESTRUTURA falhou agora: o pedido não teve resposta
 *     do Postgres (sem código: `fetch failed`, `ECONNRESET`, página 522 da
 *     Cloudflare); conexão (08xxx); recurso esgotado (53xxx); timeout,
 *     desligamento ou "ainda subindo" (57xxx); concorrência (40001, 40P01,
 *     55P03); banco em somente leitura (25006 — disco cheio); E/S (58000,
 *     58030); PostgREST sem banco (PGRST000–PGRST003).
 *     → 503 + Retry-After. A reentrega resolve sozinha.
 *
 *   - `estrutural` — o CRM está quebrado ou mal configurado: tabela, coluna ou
 *     função inexistente, permissão (42xxx); schema cache do PostgREST sem o
 *     objeto (PGRST2xx); JWT/credencial (PGRST3xx); pedido malformado que o
 *     NOSSO código montou (PGRST1xx); erro interno (XX000); qualquer código que
 *     ninguém listou. Acontece com migration faltando ou código e schema fora de
 *     passo depois de um deploy.
 *     → 500, NUNCA 200. Reentregar sozinho não resolve, mas o operador resolve
 *     (aplica a migration, corrige o deploy) — e a reentrega da Meta, que dura
 *     até 7 dias, é a janela para a mensagem entrar depois do conserto.
 *     Confirmar com 200 seria descartar a mensagem por um defeito NOSSO.
 *
 *   - `do_evento` — ESTE evento traz um dado que o banco recusa, e reentregar o
 *     mesmo corpo vai falhar do mesmo jeito: dado inválido (22xxx), integridade
 *     (23xxx; o 23505 já é tratado antes, como `duplicate`), regra de negócio
 *     levantada pelo banco (P0001).
 *     → 200 SÓ DEPOIS de guardar o evento cru em `webhook_events_log`. Sem esse
 *     arquivo, 200 é perda; com ele, o evento continua consultável e
 *     reprocessável depois de um conserto. Se nem o arquivo entrar, o evento
 *     não está durável em lugar nenhum e a resposta volta a ser 5xx.
 *
 * A regra de bolso, que as duas rotas da Meta seguem: **200 só quando o evento
 * ficou durável em algum lugar** — como mensagem, como duplicata, como recusa
 * deliberada (número de outro, número interno de aviso) ou como arquivo cru.
 *
 * ─── Por que "lista do que é passageiro", e não o contrário ─────────────────
 * Uma versão anterior tratava como permanente só 22xxx/23xxx e todo o resto
 * como passageiro, inclusive 42P01 e os erros de schema do PostgREST: erro de
 * estrutura virava "tente de novo em 30 s" para sempre. Outra tratava 42xxx
 * como permanente E respondia 200: a mensagem era descartada por migration
 * faltando. As três classes existem para as duas coisas não acontecerem.
 *
 * O canal por QR tem a sua régua em `lib/waha/falha-transitoria.ts`, com dois
 * desfechos e reentrega curta (segundos) — por isso lá o arquivo cru é a
 * principal rede de segurança, relida por um cron. Aqui a reentrega da própria
 * Meta dura dias, e o arquivo só é necessário onde ela não ajuda.
 */
export interface ErroDoBancoLike {
  code?: string | null;
  message?: string | null;
}

export type ClasseDaFalha = "transitoria" | "estrutural" | "do_evento";

/** Classes SQLSTATE inteiras que descrevem indisponibilidade, nunca o dado. */
const CLASSES_PASSAGEIRAS = new Set(["08", "53", "57"]);

/** Códigos avulsos passageiros, de classes que também têm códigos de outra natureza. */
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

/** O dado deste evento é que foi recusado. */
const CLASSES_DO_EVENTO = new Set(["22", "23"]);
const CODIGOS_DO_EVENTO = new Set(["P0001"]); // raise_exception de regra do banco

const SQLSTATE = /^[0-9A-Z]{5}$/;
const POSTGREST = /^PGRST/;

/** `null` quando não há erro. */
export function classificarFalhaDoBanco(erro: ErroDoBancoLike | null | undefined): ClasseDaFalha | null {
  if (!erro) return null;
  const codigo = typeof erro.code === "string" ? erro.code.trim().toUpperCase() : "";

  if (POSTGREST.test(codigo)) return POSTGREST_PASSAGEIROS.has(codigo) ? "transitoria" : "estrutural";
  // Sem código de banco = o pedido não teve resposta do Postgres (rede, proxy,
  // HTML de erro). Inclui os códigos do Node (`ECONNRESET`, `ETIMEDOUT`).
  if (!SQLSTATE.test(codigo)) return "transitoria";
  if (CLASSES_PASSAGEIRAS.has(codigo.slice(0, 2)) || CODIGOS_PASSAGEIROS.has(codigo)) return "transitoria";
  if (CLASSES_DO_EVENTO.has(codigo.slice(0, 2)) || CODIGOS_DO_EVENTO.has(codigo)) return "do_evento";
  return "estrutural";
}

export function ehFalhaTransitoriaDoBanco(erro: ErroDoBancoLike | null | undefined): boolean {
  return classificarFalhaDoBanco(erro) === "transitoria";
}

/**
 * A classe de uma ingestão que falhou, ou `null` se ela não falhou. `failed` sem
 * classe conta como `estrutural`: na dúvida, não confirmar o que não foi gravado.
 */
export function classeDaIngestao(o: { status: string; classe?: ClasseDaFalha }): ClasseDaFalha | null {
  if (o.status !== "failed") return null;
  return o.classe ?? "estrutural";
}
