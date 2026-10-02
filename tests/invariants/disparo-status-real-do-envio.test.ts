import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * 0501 · O STATUS DO DISPARO É O RESULTADO DO ENVIO, no banco que o clone recebe.
 *
 * Prova as funções e os gatilhos SQL de verdade (o teste unitário usa uma
 * cópia das regras em `tests/helpers/disparo-reconciliacao-em-memoria.ts`):
 *
 *   - a mensagem ligada ao destinatário (`messages.broadcast_recipient_id`)
 *     reconcilia o status dele no INSERT e em toda mudança de status — a recusa
 *     que chega depois pelo webhook inclusive;
 *   - `sent` só com mensagem aceita; `failed` com qualquer recusa;
 *   - o disparo só conclui sem `pending` nem `in_flow`;
 *   - execução de fluxo que termina sem enviar vira `skipped`, nunca `sent`;
 *   - apagar o destinatário não apaga a mensagem (só a ligação);
 *   - as funções não são alcançáveis por `anon`/`authenticated`.
 */

const ORG = "0501aaaa-0000-4000-8000-000000000001";
const SESSAO = "0501aaaa-1111-4000-8000-000000000001";
const C1 = "0501aaaa-2222-4000-8000-000000000001";
const C2 = "0501aaaa-2222-4000-8000-000000000002";
const C3 = "0501aaaa-2222-4000-8000-000000000003";
const CONV1 = "0501aaaa-3333-4000-8000-000000000001";
const CONV2 = "0501aaaa-3333-4000-8000-000000000002";
const DISPARO = "0501aaaa-4444-4000-8000-000000000001";
const DISPARO_FLUXO = "0501aaaa-4444-4000-8000-000000000002";
const FLUXO = "0501aaaa-5555-4000-8000-000000000001";
const R1 = "0501aaaa-6666-4000-8000-000000000001";
const R2 = "0501aaaa-6666-4000-8000-000000000002";
const R3 = "0501aaaa-6666-4000-8000-000000000003";
const M1 = "0501aaaa-7777-4000-8000-000000000001";
const M2 = "0501aaaa-7777-4000-8000-000000000002";

const permissao = (contato: string) =>
  `jsonb_build_object('organization_id','${ORG}','contact_id','${contato}','conversation_id',gen_random_uuid(),'service_revision',1,'demanda_id',null,'demanda_revision',null)`;

const mensagem = (id: string, conv: string, contato: string, dest: string, status: string) =>
  `insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at, broadcast_recipient_id)
   values ('${id}', '${ORG}', '${conv}', '${SESSAO}', '${contato}', 'template', 'outbound', '${status}', 'automation', now(), '${dest}');`;

const statusDe = (dest: string) =>
  sql(`select status || '|' || coalesce(error, '') from public.broadcast_recipients where id = '${dest}'`);

const disparo = (id: string) =>
  sql(`select status || '|' || sent_count || '|' || failed_count || '|' || skipped_count || '|' || in_flow_count
         from public.broadcasts where id = '${id}'`);

function seed(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-0501', 'Disparo 0501', 'Disparo 0501') on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'inv-0501', '\\x00'::bytea) on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number) values
      ('${C1}', '${ORG}', 'Ana', '+5511900000501'),
      ('${C2}', '${ORG}', 'Bia', '+5511900000502'),
      ('${C3}', '${ORG}', 'Cid', '+5511900000503')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV1}', '${ORG}', '${C1}', '${SESSAO}', 'open'),
      ('${CONV2}', '${ORG}', '${C2}', '${SESSAO}', 'open')
      on conflict do nothing;
    insert into public.broadcasts (id, organization_id, name, status) values
      ('${DISPARO}', '${ORG}', 'Disparo 0501', 'running'),
      ('${DISPARO_FLUXO}', '${ORG}', 'Disparo 0501 fluxo', 'draft')
      on conflict do nothing;
    -- O fluxo se liga com o disparo em RASCUNHO, como no produto (a 0508 recusa
    -- ligar a um disparo que já saiu); só então o disparo vai a running.
    insert into public.flows (id, organization_id, name, trigger_type, broadcast_id)
      values ('${FLUXO}', '${ORG}', 'Fluxo 0501', 'broadcast', '${DISPARO_FLUXO}') on conflict do nothing;
    update public.broadcasts set status = 'running' where id = '${DISPARO_FLUXO}';
    insert into public.broadcast_recipients (id, organization_id, broadcast_id, contact_id, status, service_boundary) values
      ('${R1}', '${ORG}', '${DISPARO}', '${C1}', 'in_flow', ${permissao(C1)}),
      ('${R2}', '${ORG}', '${DISPARO}', '${C2}', 'in_flow', ${permissao(C2)}),
      ('${R3}', '${ORG}', '${DISPARO_FLUXO}', '${C3}', 'in_flow', ${permissao(C3)})
      on conflict do nothing;
  `);
}

describe("0501 · a mensagem leva o desfecho ao destinatário", () => {
  it("mensagem em fila: o destinatário segue in_flow e o disparo NÃO conclui", () => {
    seed();
    sql(mensagem(M1, CONV1, C1, R1, "queued"));
    expect(statusDe(R1)).toBe("in_flow|");
    // O destinatário não mudou de status (já nasceu `in_flow`), então quem
    // recalcula os contadores é o worker no fim do lote — como aqui.
    sql(`select public.fn_broadcast_recount('${DISPARO}');`);
    expect(disparo(DISPARO)).toBe("running|0|0|0|2");
  });

  it("a recusa que chega DEPOIS (webhook) vira failed com o motivo do canal", () => {
    sql(`update public.messages set status = 'failed', error_code = 'meta_error',
           error_message = '(#132000) params' where id = '${M1}';`);
    expect(statusDe(R1)).toBe("failed|meta_error: (#132000) params");
    expect(disparo(DISPARO)).toBe("running|0|1|0|1");
  });

  it("mensagem aceita: sent; sem ninguém pendente nem em andamento, o disparo conclui", () => {
    sql(mensagem(M2, CONV2, C2, R2, "sent"));
    expect(statusDe(R2)).toBe("sent|");
    expect(disparo(DISPARO)).toBe("completed|1|1|0|0");
  });

  it("aceita e depois recusada (ex.: 131026 no status): o destinatário passa a failed", () => {
    sql(`update public.messages set status = 'failed', error_code = 'meta_error' where id = '${M2}';`);
    expect(statusDe(R2)).toMatch(/^failed\|meta_error/);
    expect(disparo(DISPARO)).toBe("completed|0|2|0|0");
  });

  it("apagar o destinatário não apaga a mensagem — só a ligação", () => {
    sql(`delete from public.broadcast_recipients where id = '${R1}';`);
    expect(sql(`select count(*) || '|' || count(broadcast_recipient_id) from public.messages where id = '${M1}'`)).toBe("1|0");
  });
});

describe("0501 · a execução do fluxo leva o desfecho ao destinatário", () => {
  it("execução que termina sem enviar nada: skipped, nunca sent", () => {
    sql(`insert into public.flow_executions (organization_id, flow_id, contact_id, broadcast_recipient_id, service_boundary)
           values ('${ORG}', '${FLUXO}', '${C3}', '${R3}', ${permissao(C3)});
         update public.flow_executions set status = 'completed' where broadcast_recipient_id = '${R3}';`);
    expect(statusDe(R3)).toBe("skipped|fluxo_concluido_sem_envio");
    expect(disparo(DISPARO_FLUXO)).toBe("completed|0|0|1|0");
  });
});

describe("0501 · superfície", () => {
  it("as funções não são alcançáveis pela anon key nem por usuário logado", () => {
    for (const fn of [
      "public.fn_broadcast_recount(uuid)",
      "public.fn_broadcast_recipient_reconcile(uuid)",
    ]) {
      expect(
        sql(`select has_function_privilege('anon', '${fn}', 'execute')::text || '|' ||
                    has_function_privilege('authenticated', '${fn}', 'execute')::text`),
      ).toBe("false|false");
    }
  });

  it("o status `in_flow` está no vocabulário e um status inventado não", () => {
    expect(() =>
      sql(`update public.broadcast_recipients set status = 'entregue' where id = '${R3}';`),
    ).toThrow();
  });
});
