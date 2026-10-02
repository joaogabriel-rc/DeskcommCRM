/**
 * As regras de `fn_broadcast_recipient_reconcile` e `fn_broadcast_recount`
 * (migration 0501) para o banco dublê dos testes unitários.
 *
 * É uma CÓPIA das regras, não a fonte: quem prova a função SQL de verdade é
 * `tests/invariants/disparo-status-real-do-envio.test.ts`, contra o baseline.
 * Aqui ela existe para o worker e o motor rodarem de ponta a ponta sem Postgres.
 * Se uma regra mudar no SQL, as duas suítes mudam juntas — a invariante
 * reprova se só esta cópia for atualizada.
 */
import type { BancoEmMemoria } from "./banco-em-memoria";

type Linha = Record<string, unknown>;

const ACEITAS = new Set(["sent", "delivered", "read"]);

export function reconciliarDestinatario(banco: BancoEmMemoria, recipientId: string): string | null {
  const r = (banco.tabelas.broadcast_recipients ?? []).find((x) => x.id === recipientId) as Linha | undefined;
  if (!r) return null;
  const atual = String(r.status);
  if (!["in_flow", "sent", "failed"].includes(atual)) return atual;

  const msgs = (banco.tabelas.messages ?? []).filter(
    (m) => m.broadcast_recipient_id === r.id && m.organization_id === r.organization_id,
  );
  const recusada = msgs.find((m) => m.status === "failed");
  const aceita = msgs.some((m) => ACEITAS.has(String(m.status)));
  const exec = (banco.tabelas.flow_executions ?? []).find(
    (e) => e.broadcast_recipient_id === r.id && e.organization_id === r.organization_id,
  );

  let novo: string;
  let erro: string | null;
  if (recusada) {
    novo = "failed";
    erro = [recusada.error_code, recusada.error_message].filter(Boolean).join(": ") || "envio_recusado";
  } else if (aceita) {
    novo = "sent";
    erro = null;
  } else if (exec && exec.status === "failed") {
    novo = "failed";
    erro = String(exec.last_error ?? "flow_failed").slice(0, 300);
  } else if (exec && exec.status === "completed" && msgs.length === 0) {
    novo = "skipped";
    erro = "fluxo_concluido_sem_envio";
  } else if (exec && exec.status === "cancelled" && msgs.length === 0) {
    novo = "skipped";
    erro = "fluxo_cancelado";
  } else if (msgs.length > 0 || exec) {
    novo = "in_flow";
    erro = null;
  } else {
    return atual;
  }

  if (novo !== atual || erro !== (r.error ?? null)) {
    r.status = novo;
    r.error = erro;
    if (novo === "sent" && !r.sent_at) r.sent_at = new Date().toISOString();
    recontarDisparo(banco, String(r.broadcast_id));
  }
  return novo;
}

export function recontarDisparo(banco: BancoEmMemoria, broadcastId: string): Record<string, unknown> {
  const doDisparo = (banco.tabelas.broadcast_recipients ?? []).filter((x) => x.broadcast_id === broadcastId);
  const conta = (s: string) => doDisparo.filter((x) => x.status === s).length;
  const c = {
    pending: conta("pending"),
    in_flow: conta("in_flow"),
    sent: conta("sent"),
    failed: conta("failed"),
    skipped: conta("skipped"),
  };
  const b = (banco.tabelas.broadcasts ?? []).find((x) => x.id === broadcastId);
  if (!b) return { status: null, ...c };
  b.sent_count = c.sent;
  b.failed_count = c.failed;
  b.skipped_count = c.skipped;
  b.in_flow_count = c.in_flow;
  if (b.status === "running" && c.pending === 0 && c.in_flow === 0) {
    b.status = "completed";
    b.finished_at ??= new Date().toISOString();
  }
  return { status: b.status, ...c };
}

/** As duas RPCs, prontas para `criarBanco(..., rpcs)`. */
export function rpcsDaReconciliacao(banco: () => BancoEmMemoria) {
  return {
    fn_broadcast_recipient_reconcile: (a: Record<string, unknown>) =>
      reconciliarDestinatario(banco(), String(a.p_recipient)),
    fn_broadcast_recount: (a: Record<string, unknown>) => recontarDisparo(banco(), String(a.p_broadcast)),
  };
}

/**
 * O que os GATILHOS da 0501 fazem: a mensagem gravada (ou que mudou de status)
 * e a execução que mudou de status reconciliam o destinatário. O dublê não tem
 * gatilho; o teste chama isto depois de gravar.
 */
export function gravarMensagemDoDisparo(
  banco: BancoEmMemoria,
  linha: { organization_id: string; broadcast_recipient_id?: string | null; status: string; error_code?: string | null; error_message?: string | null },
): Linha {
  banco.tabelas.messages ??= [];
  const m: Linha = { id: `msg-${banco.tabelas.messages.length + 1}`, ...linha };
  banco.tabelas.messages.push(m);
  if (linha.broadcast_recipient_id) reconciliarDestinatario(banco, linha.broadcast_recipient_id);
  return m;
}
