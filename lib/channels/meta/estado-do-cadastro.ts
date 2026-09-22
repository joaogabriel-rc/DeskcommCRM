/**
 * O `state` do Cadastro Incorporado da Meta — assinado, com prazo, amarrado à
 * organização e à pessoa que abriu o fluxo, e de uso único.
 *
 * A construção é a de `lib/agenda/google/estado.ts` (HMAC-SHA256, prazo, tempo
 * constante), reaproveitada e não copiada. O que muda é a CHAVE: ela é derivada
 * do `INTERNAL_SECRET` com um rótulo deste fluxo. Com a mesma chave e o mesmo
 * formato, um `state` emitido para a Agenda seria aceito aqui — e vice-versa.
 *
 * O uso único é a queima do nonce em `calendar_oauth_nonces` (migration 0190):
 * a tabela de nonces de OAuth que já existe, com RLS fechada e poda diária pelo
 * cron `data-retention`. O prefixo separa as origens na mesma tabela.
 */
import { createHmac } from "node:crypto";

import { emitirEstado, verificarEstado, type EstadoDaConexao } from "@/lib/agenda/google/estado";

/** Quinze minutos: o fluxo da Meta pode pedir criação de conta e código por SMS. */
export const VALIDADE_DO_ESTADO_DO_CADASTRO_MS = 15 * 60 * 1000;

export const PREFIXO_DO_NONCE_DO_CADASTRO = "meta-es:";

const ROTULO = "cadastro-incorporado-meta";

/**
 * Derivar de um segredo curto daria uma chave de 64 hex com aparência de forte —
 * a guarda de tamanho do módulo do Google passaria. Por isso a guarda é AQUI,
 * sobre o segredo de verdade, e lança: quem chama transforma em recusa.
 */
function chaveDoFluxo(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < 16) {
    throw new Error("INTERNAL_SECRET ausente ou curto demais: o state do cadastro não tem como ser assinado");
  }
  return createHmac("sha256", s).update(ROTULO, "utf8").digest("hex");
}

export function emitirEstadoDoCadastro(
  dados: { organizationId: string; userId: string },
  opcoes: { segredo: string; agora: Date },
): string {
  return emitirEstado(dados, {
    segredo: chaveDoFluxo(opcoes.segredo),
    agora: opcoes.agora,
    validadeMs: VALIDADE_DO_ESTADO_DO_CADASTRO_MS,
  });
}

/** `null` para qualquer recusa (assinatura, prazo, formato) — o motivo não vai ao navegador. */
export function verificarEstadoDoCadastro(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDaConexao | null {
  return verificarEstado(token, { segredo: chaveDoFluxo(opcoes.segredo), agora: opcoes.agora });
}
