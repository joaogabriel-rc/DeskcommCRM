/**
 * O DESFECHO de um pedido de envio, lido da linha que `sendMessageHandler`
 * devolve.
 *
 * ── Por que isto existe ─────────────────────────────────────────────────────
 *
 * `sendMessageHandler` NÃO lança quando o canal recusa: ele grava a linha
 * `failed` (com `error_code`/`error_message`) e a devolve. Quem chamava e
 * ignorava o retorno tratava recusa como sucesso — foi assim que um disparo com
 * duas mensagens recusadas pela Meta terminou `completed`, `sent_count = 2`.
 *
 * Três desfechos, e só três:
 *
 *   - `aceito`   o canal aceitou (`sending`/`sent`/`delivered`/`read`);
 *   - `recusado` a linha terminou `failed` — pelo canal ou por guarda local;
 *   - `em_fila`  `queued`: canal sem credencial ou sessão fora de `WORKING`.
 *                Não é sucesso nem falha AINDA; a mensagem pode sair depois
 *                (o watchdog reenvia `queued` quando a sessão volta).
 *
 * Uma recusa que chega DEPOIS (webhook de status) não passa por aqui: quem a
 * leva ao disparo é o gatilho da migration 0501.
 */

export type DesfechoDoEnvio =
  | { kind: "aceito" }
  | { kind: "recusado"; codigo: string; motivo: string }
  | { kind: "em_fila"; motivo: string };

interface LinhaDeEnvio {
  status?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function desfechoDoEnvio(linha: LinhaDeEnvio | null | undefined): DesfechoDoEnvio {
  const status = linha?.status ?? "";
  if (status === "failed") {
    const codigo = linha?.error_code?.trim() || "send_failed";
    return { kind: "recusado", codigo, motivo: linha?.error_message?.trim() || codigo };
  }
  if (status === "queued") {
    const razao = linha?.metadata?.queued_reason;
    return { kind: "em_fila", motivo: typeof razao === "string" && razao ? razao : "queued" };
  }
  if (status === "sending" || status === "sent" || status === "delivered" || status === "read") {
    return { kind: "aceito" };
  }
  // Linha ausente ou status desconhecido: não se afirma sucesso sem prova.
  return { kind: "recusado", codigo: "send_outcome_unknown", motivo: `status inesperado: ${status || "vazio"}` };
}

/** A frase curta que vai para `last_error` / `broadcast_recipients.error`. */
export function erroDoDesfecho(d: Extract<DesfechoDoEnvio, { kind: "recusado" }>): string {
  const motivo = d.motivo && d.motivo !== d.codigo ? `: ${d.motivo}` : "";
  return `envio_recusado:${d.codigo}${motivo}`.slice(0, 300);
}
