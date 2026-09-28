/**
 * `getUser()` sem repetir, dentro de UMA requisição, a ida ao GoTrue que o
 * `proxy.ts` acabou de fazer. O porquê e a prova de que não se forja moram em
 * `lib/auth/identidade-assinada.ts`.
 *
 * Regra de uso: troca `supabase.auth.getUser()` (sem argumento) em código de
 * LEITURA de identidade. Ações que MUDAM a sessão (login, logout, MFA, senha)
 * seguem chamando o `getUser()` direto — e, mesmo que não seguissem, a amarra
 * com os cookies faria a identidade antiga ser recusada assim que eles mudam.
 */
import type { User, UserResponse } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

import { env } from "@/lib/env";
import { NOME_DO_COOKIE_DE_SESSAO } from "@/lib/supabase/server";
import {
  CABECALHO_IDENTIDADE,
  verificarIdentidade,
  vinculoDosCookies,
} from "@/lib/auth/identidade-assinada";

type ClienteComAuth = { auth: { getUser: () => Promise<UserResponse> } };

/**
 * O `User` que o proxy validou para ESTA requisição e ESTES cookies, ou `null`.
 * Fora de uma requisição (worker, teste, script), `headers()` lança — e isso
 * também é `null`: quem chama cai no `getUser()` de sempre.
 */
export async function usuarioVerificadoPeloProxy(): Promise<User | null> {
  try {
    const [h, c] = await Promise.all([headers(), cookies()]);
    const valor = h.get(CABECALHO_IDENTIDADE);
    if (!valor) return null;
    return await verificarIdentidade(
      valor,
      { nome: NOME_DO_COOKIE_DE_SESSAO, todos: c.getAll() },
      env.SUPABASE_SERVICE_ROLE_KEY,
    );
  } catch {
    return null;
  }
}

/** Mesmo contrato de `supabase.auth.getUser()`; só pula a ida quando o proxy já foi. */
export async function getUserDaRequisicao(supabase: ClienteComAuth): Promise<UserResponse> {
  const user = await usuarioVerificadoPeloProxy();
  if (user) return { data: { user }, error: null };
  return supabase.auth.getUser();
}

/**
 * O escopo de UMA requisição, para memoizar onde o `cache()` do React não
 * alcança.
 *
 * ⚠️ `cache()` do React é NO-OP em Route Handler: o Next só instala o
 * dispatcher de cache durante o render de Server Components. Medido — em
 * `/api/v1/*`, cada `loadAuthUser()` refazia a cadeia inteira, e rota mutante
 * chama duas (`requireSupportWrite` + `requireRole`).
 *
 * A chave é o objeto de cabeçalhos DAQUELA requisição (`await headers()`
 * devolve a mesma instância durante toda ela, e uma nova na próxima) somado ao
 * hash dos cookies de sessão: se a sessão mudar no meio (login, MFA), é outra
 * entrada. Nada aqui é compartilhado entre requisições — e, portanto, entre
 * usuários ou organizações: o `WeakMap` morre com a requisição.
 */
export async function escopoDaRequisicao(): Promise<{ chave: object; vinculo: string } | null> {
  try {
    const [h, c] = await Promise.all([headers(), cookies()]);
    const vinculo =
      (await vinculoDosCookies({ nome: NOME_DO_COOKIE_DE_SESSAO, todos: c.getAll() })) ??
      "sem-sessao";
    return { chave: h as unknown as object, vinculo };
  } catch {
    return null;
  }
}
