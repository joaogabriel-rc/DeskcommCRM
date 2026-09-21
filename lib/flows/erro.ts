/**
 * O MOTIVO DA FALHA, LEGÍVEL — a aba Atividade é lida por quem opera.
 *
 * `String(err)` num objeto devolve `[object Object]`, e foi exatamente o que a
 * primeira versão gravou em `flow_executions.last_error` quando o erro veio do
 * PostgREST (que rejeita com objeto simples, não com `Error`): o operador via
 * "[object Object]" e não tinha como saber que a fronteira de serviço havia
 * recusado a origem do evento. Erro que não se explica é erro que ninguém
 * conserta.
 */
export function motivoDoErro(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    // Forma do PostgrestError: {message, code, details, hint}.
    const partes = [obj.message, obj.code, obj.details].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (partes.length) return partes.join(" · ");
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return "erro_nao_serializavel";
    }
  }
  return String(err);
}
