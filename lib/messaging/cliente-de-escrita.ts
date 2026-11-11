/**
 * QUEM ESCREVE EM `messages` QUANDO A ESCRITA NASCE DE UMA SESSÃO DE USUÁRIO.
 *
 * Desde a migration 9332 o papel `authenticated` não tem UPDATE em `messages`:
 * o mesmo JWT que chega às rotas chega ao PostgREST, e lá não há papel,
 * autoria, janela de edição nem auditoria. As rotas que atualizam mensagem
 * (envio, editar/apagar a própria enviada, ocultar no CRM) autorizam pela
 * SESSÃO e então gravam pelo cliente que este módulo devolve — o service role.
 *
 * Quem chama assume as duas obrigações que a RLS deixava de cumprir:
 *   - a autorização já aconteceu (papel, autoria, alvo) ANTES da escrita;
 *   - toda escrita leva `organization_id` explícito, tirado da sessão e nunca
 *     do corpo (anti-pattern 10 do CLAUDE.md).
 *
 * O parâmetro é a sessão de quem pediu. Ele não é usado para escrever — está
 * na assinatura para que cada chamador declare de QUAL sessão a escrita nasce,
 * e para que o dublê dos testes possa devolver o mesmo banco falso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

export function clienteDeEscritaDeMensagens(_sessao: SupabaseClient): SupabaseClient {
  return createAdminClient();
}
