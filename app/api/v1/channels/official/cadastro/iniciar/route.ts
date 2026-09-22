/**
 * POST /api/v1/channels/official/cadastro/iniciar — prepara o Cadastro
 * Incorporado da Meta: emite o `state` que a conclusão vai exigir.
 *
 * O navegador chama isto ANTES do clique, e não dentro dele: o popup da Meta só
 * abre se `FB.login` for chamado de forma síncrona no gesto do usuário, e um
 * `await` no meio o transformaria em popup bloqueado.
 *
 * O `state` carrega organização, pessoa, nonce e prazo, assinado no servidor. Não
 * grava nada: a queima do nonce acontece na conclusão, no primeiro uso.
 */
import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { disponibilidadeDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado";
import {
  VALIDADE_DO_ESTADO_DO_CADASTRO_MS,
  emitirEstadoDoCadastro,
} from "@/lib/channels/meta/estado-do-cadastro";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cadastro = await disponibilidadeDoCadastroIncorporado();
  if (!cadastro.disponivel) {
    return fail("state_conflict", t("A conexão pela Meta não está configurada nesta instalação."), 409, {
      requestId,
      details: { motivo: "cadastro_indisponivel", faltando: cadastro.faltando },
    });
  }

  const limite = await checkRateLimit(`meta-cadastro:iniciar:${authz.org.orgId}`, 20, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas tentativas seguidas. Aguarde alguns minutos."), 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const agora = new Date();
  let state: string;
  try {
    state = emitirEstadoDoCadastro(
      { organizationId: authz.org.orgId, userId: authz.user.id },
      { segredo: env.INTERNAL_SECRET, agora },
    );
  } catch {
    logger.error("[meta.cadastro] state não emitido: INTERNAL_SECRET ausente ou curto", {
      requestId,
      organizationId: authz.org.orgId,
    });
    return fail("internal_error", t("A instalação não consegue assinar a conexão agora."), 500, { requestId });
  }

  return ok({
    state,
    expira_em: new Date(agora.getTime() + VALIDADE_DO_ESTADO_DO_CADASTRO_MS).toISOString(),
  });
}
