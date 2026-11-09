import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_SESSION,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Migration 9254 — o evento de mensagem carrega `conteudo_indisponivel`, e o
 * original da Meta em `metadata` sai com a anonimização.
 *
 * Contra o trigger REAL do baseline (não um dublê):
 *   - mensagem com `metadata.conteudo_indisponivel = true` → o `message.received`
 *     traz a chave `true`, que o dispatcher usa para pular os handlers que respondem;
 *   - mensagem comum → o payload sai com EXATAMENTE as chaves de antes (nenhuma
 *     mensagem normal muda de comportamento);
 *   - valor estranho na marca (`"abc"`) → o INSERT passa e a chave não aparece
 *     (comparação textual, nunca cast que derrubaria a gravação);
 *   - `fn_lgpd_cascade_redact_contact` zera `metadata` — `meta_original`, com o
 *     conteúdo cru da Meta, não sobra em lugar nenhum da linha.
 *
 * Controle: sem o bloco da 9254 no baseline, o primeiro caso falha (a chave
 * não existe no payload).
 */

const CHAVES_DE_ANTES = [
  "body_preview",
  "channel_session_id",
  "contact_id",
  "conversation_id",
  "direction",
  "external_id",
  "message_id",
  "status",
  "type",
];

function inserirMensagem(
  externalId: string,
  metadata: string,
  body = "[Enquete — rótulo]",
): string {
  return lastLine(
    sql(`
      with nova as (
        insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id,
                                     direction, status, type, body, external_id, metadata)
        values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
                'inbound', 'delivered', 'text', '${body}', '${externalId}', '${metadata}'::jsonb)
        returning id
      )
      select id from nova;
    `),
  );
}

function payloadDoEvento(messageId: string): Record<string, unknown> {
  const out = lastLine(
    sql(`
      select payload::text from public.event_log
       where organization_id = '${GOV_ORG}' and event_type = 'message.received'
         and payload->>'message_id' = '${messageId}'
       order by created_at desc limit 1;
    `),
  );
  return JSON.parse(out) as Record<string, unknown>;
}

beforeAll(() => {
  seedGov();
});

describe("9254 — a marca no payload do evento de mensagem", () => {
  it("mensagem sem conteúdo: o message.received leva conteudo_indisponivel = true", () => {
    const id = inserirMensagem(
      "wamid.inv.sem-conteudo",
      '{"conteudo_indisponivel": true, "meta_original": {"type": "unsupported"}}',
    );
    expect(payloadDoEvento(id).conteudo_indisponivel).toBe(true);
  });

  it("mensagem comum: o payload tem exatamente as chaves de antes", () => {
    const id = inserirMensagem("wamid.inv.normal", '{"meta_original": {"type": "text"}}', "oi");
    expect(Object.keys(payloadDoEvento(id)).sort()).toEqual(CHAVES_DE_ANTES);
  });

  it("valor estranho na marca não derruba o INSERT e não vira marca", () => {
    const id = inserirMensagem("wamid.inv.estranho", '{"conteudo_indisponivel": "abc"}');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payloadDoEvento(id).conteudo_indisponivel).toBeUndefined();
  });

  it("a anonimização LGPD zera metadata — meta_original não sobra", () => {
    const id = inserirMensagem(
      "wamid.inv.lgpd",
      '{"meta_original": {"type": "text", "text": {"body": "meu CPF é 000"}}, "order": {"x": 1}}',
      "meu CPF é 000",
    );
    sql(
      `select public.fn_lgpd_cascade_redact_contact('${GOV_ORG}', '${GOV_CONTACT_1}', gen_random_uuid());`,
    );
    const linha = JSON.parse(
      lastLine(sql(`select to_jsonb(m)::text from public.messages m where id = '${id}';`)),
    ) as {
      metadata: Record<string, unknown>;
      body: string;
    };
    expect(linha.metadata).toEqual({});
    expect(JSON.stringify(linha)).not.toContain("CPF");
  });
});
