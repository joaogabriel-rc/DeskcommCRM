import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * Migration 9332 — UPDATE em `public.messages` é só do servidor, e o que foi
 * apagado não volta. Num Postgres real, com o baseline aplicado e o default ACL
 * do Supabase reproduzido pelo prelude de `scripts/test-db.sh`.
 *
 * ## O defeito que isto vigia (medido em 11/11/2026)
 *
 * A policy `messages_update` só exigia "pertencer à organização", e `anon` /
 * `authenticated` tinham UPDATE e TRUNCATE. Pelo PostgREST — o mesmo JWT do
 * navegador — um `viewer` reescrevia texto, desfazia `revoked_at` devolvendo
 * conteúdo apagado pelo contato e falsificava status e autor.
 *
 * ## A matriz
 *
 *   - CATÁLOGO: nem PUBLIC, nem `anon`, nem `authenticated` têm UPDATE ou
 *     TRUNCATE — na tabela e em coluna nenhuma —, e não há policy permissiva de
 *     UPDATE. Isso cobre todo papel que chega pelo PostgREST: membro de qualquer
 *     papel, de outra organização, platform admin e suporte temporário são
 *     todos `authenticated`.
 *   - COMPORTAMENTO: cada um desses atores tenta as cinco escritas da
 *     auditoria e recebe recusa. O controle prova que a leitura e o INSERT
 *     (Fase 2, intocado) continuam.
 *   - DEFAULT ACL: o GRANT ALL que o dump/default ACL reaplica a cada
 *     `update.sh` é curado pelo bloco do apêndice reaplicado.
 *   - TRIGGER: vale para service role E para o dono. Organização e direção não
 *     mudam; `revoked_at` não volta a nulo; recebida apagada não volta a ter
 *     texto, mídia ou transcrição. As transições legítimas (status, edição de
 *     enviada, ocultar, apagamento que limpa, marcador da LGPD) passam.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO =
  "-- ---- UPDATE em messages é só do servidor, e o que foi apagado não volta (migration 9332) ----";

const ORG_A = "93320000-aaaa-4000-8000-000000000001";
const ORG_B = "93320000-bbbb-4000-8000-000000000001";
const SESSAO_A = "93320000-aaaa-4000-8000-0000000000a1";
const SESSAO_B = "93320000-bbbb-4000-8000-0000000000b1";
const CONTATO_A = "93320000-aaaa-4000-8000-0000000000c1";
const CONTATO_B = "93320000-bbbb-4000-8000-0000000000c1";
const CONV_A = "93320000-aaaa-4000-8000-0000000000d1";
const CONV_B = "93320000-bbbb-4000-8000-0000000000d1";

const VIEWER = "93320000-aaaa-4111-8000-000000000001";
const AGENT = "93320000-aaaa-4111-8000-000000000002";
const MANAGER = "93320000-aaaa-4111-8000-000000000003";
const ADMIN = "93320000-aaaa-4111-8000-000000000004";
const ADMIN_B = "93320000-bbbb-4111-8000-000000000004";
const PLATAFORMA = "93320000-cccc-4111-8000-000000000001";

/** Mensagens fixas da org A (e uma da B), recriadas a cada caso de escrita. */
const M = {
  recebida: "93320000-aaaa-4222-8000-000000000001",
  recebidaApagada: "93320000-aaaa-4222-8000-000000000002",
  enviada: "93320000-aaaa-4222-8000-000000000003",
  enviadaApagada: "93320000-aaaa-4222-8000-000000000004",
  legadoApagada: "93320000-aaaa-4222-8000-000000000005",
  daOrgB: "93320000-bbbb-4222-8000-000000000001",
};

function bloco9332(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 9332 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 9332 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 9332 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** Recria as mensagens no estado de partida (como dono: o seed não passa pelo trigger de UPDATE). */
function semearMensagens(): void {
  sql(`
    delete from public.messages where id in (${Object.values(M).map((id) => `'${id}'`).join(",")});
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_by_user_id, revoked_at, media_storage_path, sent_at, metadata)
    values
      ('${M.recebida}',        '${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'text',  'inbound',  'delivered', 'external_device', 'texto do cliente',        null,        null,  null,                 '2026-11-11T10:00:00Z', '{}'),
      ('${M.recebidaApagada}', '${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'image', 'inbound',  'delivered', 'external_device', null,                      null,        now(), null,                 '2026-11-11T10:01:00Z', '{"apagamento":{"por":"contato"}}'),
      ('${M.enviada}',         '${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'text',  'outbound', 'sent',      'crm', 'texto da empresa',        '${AGENT}', null,  null,                 '2026-11-11T10:02:00Z', '{}'),
      ('${M.enviadaApagada}',  '${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'text',  'outbound', 'sent',      'crm', 'visível só aqui no CRM',  '${AGENT}', now(), null,                 '2026-11-11T10:03:00Z', '{}'),
      ('${M.legadoApagada}',   '${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'image', 'inbound',  'delivered', 'external_device', 'apagada na regra antiga', null,        now(), '${ORG_A}/x/legado.jpg', '2026-11-11T10:04:00Z', '{}'),
      ('${M.daOrgB}',          '${ORG_B}', '${CONV_B}', '${SESSAO_B}', '${CONTATO_B}', 'text',  'inbound',  'delivered', 'external_device', 'texto da org B',          null,        null,  null,                 '2026-11-11T10:05:00Z', '{}');
  `);
}

const campo = (id: string, coluna: string): string =>
  sql(`select coalesce(${coluna}::text, '<nulo>') from public.messages where id = '${id}';`);

type Ator = { nome: string; papel: "anon" | "authenticated"; sub: string | null };

const ATORES: Ator[] = [
  { nome: "anon (chave pública)", papel: "anon", sub: null },
  { nome: "viewer da org A", papel: "authenticated", sub: VIEWER },
  { nome: "agent da org A (autor da enviada)", papel: "authenticated", sub: AGENT },
  { nome: "manager da org A", papel: "authenticated", sub: MANAGER },
  { nome: "admin da org A", papel: "authenticated", sub: ADMIN },
  { nome: "admin da org B (outra organização)", papel: "authenticated", sub: ADMIN_B },
  { nome: "platform admin pelo cliente do usuário", papel: "authenticated", sub: PLATAFORMA },
];

/** As cinco escritas que a auditoria provou possíveis antes da 9332. */
const ESCRITAS: Array<{ nome: string; dml: string; alvo: string; coluna: string }> = [
  { nome: "reescrever o texto", dml: `update public.messages set body = 'ADULTERADO' where id = '${M.recebida}'`, alvo: M.recebida, coluna: "body" },
  { nome: "desfazer o apagamento e devolver texto", dml: `update public.messages set revoked_at = null, body = 'RESTAURADO' where id = '${M.recebidaApagada}'`, alvo: M.recebidaApagada, coluna: "revoked_at" },
  { nome: "falsificar status e autor", dml: `update public.messages set status = 'read', sent_by_user_id = '${VIEWER}' where id = '${M.enviada}'`, alvo: M.enviada, coluna: "status" },
  { nome: "ocultar no CRM direto (metadata)", dml: `update public.messages set metadata = '{"crm_hidden_at":"x"}' where id = '${M.recebida}'`, alvo: M.recebida, coluna: "metadata" },
  { nome: "mover para outra organização", dml: `update public.messages set organization_id = '${ORG_B}' where id = '${M.recebida}'`, alvo: M.recebida, coluna: "organization_id" },
];

/** Roda a escrita como o ator; devolve "recusado: <motivo>" ou "N linha(s)". */
function escreverComo(ator: Ator, dml: string): string {
  const claims = ator.sub ? `{"sub":"${ator.sub}","role":"authenticated"}` : `{"role":"anon"}`;
  try {
    const out = sql(`
      set role ${ator.papel};
      select set_config('request.jwt.claims', '${claims}', false);
      with w as (${dml} returning 1) select count(*) from w;
    `);
    const n = out.split("\n").pop() ?? "";
    return `${n} linha(s)`;
  } catch (err) {
    const m = motivoDoErro(err);
    if (/permission denied|row-level security/i.test(m)) return "recusado";
    throw err;
  }
}

/** Roda como service role (ou dono); devolve "ok" ou o código/mensagem do erro. */
function comoServidor(dml: string, papel: "service_role" | "postgres" = "service_role"): string {
  try {
    sql(`${papel === "service_role" ? "set role service_role;" : ""} ${dml};`);
    return "ok";
  } catch (err) {
    const m = motivoDoErro(err);
    const marca = /messages_imutavel: [^\n(]+/.exec(m);
    return marca ? marca[0].trim() : m;
  }
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${VIEWER}', 'msg9332-viewer@invariant.test'),
      ('${AGENT}', 'msg9332-agent@invariant.test'),
      ('${MANAGER}', 'msg9332-manager@invariant.test'),
      ('${ADMIN}', 'msg9332-admin@invariant.test'),
      ('${ADMIN_B}', 'msg9332-admin-b@invariant.test'),
      ('${PLATAFORMA}', 'msg9332-plataforma@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'msg9332-a', 'Org 9332 A', 'Org 9332 A'),
      ('${ORG_B}', 'msg9332-b', 'Org 9332 B', 'Org 9332 B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER}', '${ORG_A}', 'viewer', now()),
      ('${AGENT}', '${ORG_A}', 'agent', now()),
      ('${MANAGER}', '${ORG_A}', 'manager', now()),
      ('${ADMIN}', '${ORG_A}', 'admin', now()),
      ('${ADMIN_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason, mfa_required)
      values ('${PLATAFORMA}', '${PLATAFORMA}', 'invariante 9332', false)
      on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
        ('${SESSAO_A}', '${ORG_A}', 'msg9332-a', '\\x00'::bytea),
        ('${SESSAO_B}', '${ORG_B}', 'msg9332-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Contato 9332 A'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato 9332 B')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open'),
      ('${CONV_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open')
      on conflict do nothing;
  `);
  semearMensagens();
});

describe("9332 — catálogo: o PostgREST não tem UPDATE nem TRUNCATE em messages", () => {
  for (const papel of ["public", "anon", "authenticated"]) {
    it(`${papel}: sem UPDATE e sem TRUNCATE na tabela`, () => {
      const r = sql(`
        select string_agg(privilege_type, ',' order by privilege_type)
          from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'messages'
           and grantee = '${papel === "public" ? "PUBLIC" : papel}'
           and privilege_type in ('UPDATE', 'TRUNCATE');
      `);
      expect(r).toBe("");
    });

    it(`${papel}: sem UPDATE em coluna nenhuma`, () => {
      const r = sql(`
        select coalesce(string_agg(a.attname, ','), '')
          from pg_attribute a
         where a.attrelid = 'public.messages'::regclass and a.attnum > 0 and not a.attisdropped
           and has_column_privilege('${papel}', 'public.messages'::regclass, a.attnum, 'UPDATE');
      `);
      expect(r).toBe("");
    });
  }

  it("não sobra policy permissiva de UPDATE em messages", () => {
    const r = sql(`
      select coalesce(string_agg(policyname, ','), '')
        from pg_policies
       where schemaname = 'public' and tablename = 'messages'
         and cmd in ('UPDATE', 'ALL') and permissive = 'PERMISSIVE';
    `);
    expect(r).toBe("");
  });

  it("a função do trigger não é executável por anon nem por PUBLIC", () => {
    expect(sql(`select has_function_privilege('anon', 'public.fn_messages_imutaveis()', 'EXECUTE');`)).toBe("f");
  });

  it("o trigger está ligado (BEFORE UPDATE, por linha)", () => {
    expect(
      sql(`select tgenabled from pg_trigger where tgrelid = 'public.messages'::regclass and tgname = 'trg_messages_imutaveis';`),
    ).toBe("O");
  });
});

describe("9332 — default ACL: o GRANT ALL reaplicado pelo update.sh é curado pelo apêndice", () => {
  it("concede tudo de novo (como o dump/default ACL), reaplica o bloco e a escrita volta a ser recusada", () => {
    sql(`grant all on table public.messages to public, anon, authenticated;`);
    expect(sql(`select has_table_privilege('authenticated', 'public.messages', 'UPDATE');`)).toBe("t");
    sql(bloco9332());
    for (const papel of ["public", "anon", "authenticated"]) {
      expect(sql(`select has_table_privilege('${papel}', 'public.messages', 'UPDATE');`), papel).toBe("f");
      expect(sql(`select has_table_privilege('${papel}', 'public.messages', 'TRUNCATE');`), papel).toBe("f");
    }
    // e o bloco é idempotente: reaplicar de novo não erra
    expect(() => sql(bloco9332())).not.toThrow();
    // o GRANT ALL de cima devolveu INSERT/DELETE/SELECT: são a Fase 2 e seguem como antes
    expect(sql(`select has_table_privilege('authenticated', 'public.messages', 'SELECT');`)).toBe("t");
  });

  it("GRANT de COLUNA também é curado", () => {
    sql(`grant update (body, revoked_at) on table public.messages to authenticated;`);
    sql(bloco9332());
    expect(
      sql(`select has_column_privilege('authenticated', 'public.messages', 'body', 'UPDATE');`),
    ).toBe("f");
  });
});

describe("9332 — comportamento: nenhum ator do PostgREST altera mensagem", () => {
  for (const ator of ATORES) {
    for (const e of ESCRITAS) {
      it(`${ator.nome} — ${e.nome}: recusado, e a linha fica como estava`, () => {
        semearMensagens();
        const antes = campo(e.alvo, e.coluna);
        expect(escreverComo(ator, e.dml)).toBe("recusado");
        expect(campo(e.alvo, e.coluna)).toBe(antes);
      });
    }
  }

  it("ninguém do PostgREST faz TRUNCATE", () => {
    let motivo = "";
    try {
      sql(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${ADMIN}"}',false); truncate public.messages;`);
    } catch (err) {
      motivo = motivoDoErro(err);
    }
    expect(motivo).toMatch(/permission denied/);
    expect(Number(sql(`select count(*) from public.messages where organization_id = '${ORG_A}';`))).toBeGreaterThan(0);
  });

  it("CONTROLE — leitura segue: o membro vê as mensagens da sua organização, e só delas", () => {
    semearMensagens();
    const ver = (sub: string, org: string) =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${sub}"}', false);
        select count(*) from public.messages where organization_id = '${org}';
      `).split("\n").pop();
    expect(Number(ver(VIEWER, ORG_A))).toBe(5);
    expect(Number(ver(VIEWER, ORG_B))).toBe(0);
    expect(Number(ver(ADMIN_B, ORG_A))).toBe(0);
  });

  it("CONTROLE — INSERT (Fase 2, fora desta migration) segue como estava para o agent", () => {
    const r = escreverComo(
      { nome: "agent", papel: "authenticated", sub: AGENT },
      `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
       values ('${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}', 'text', 'outbound', 'sending', 'crm', 'envio pela tela', now())`,
    );
    expect(r).toBe("1 linha(s)");
  });
});

describe("9332 — trigger: o servidor faz o legítimo, e nem ele desfaz o apagamento", () => {
  // ── o que o produto faz e tem de continuar podendo ──
  const LEGITIMAS: Array<[string, string]> = [
    ["envio: status e external_id", `update public.messages set status = 'delivered', external_id = 'wamid.9332' where id = '${M.enviada}'`],
    ["edição da enviada pelo autor", `update public.messages set body = 'texto corrigido', edited_at = now() where id = '${M.enviada}'`],
    ["apagar a enviada (empresa)", `update public.messages set revoked_at = now() where id = '${M.enviada}'`],
    ["ocultar a recebida no CRM", `update public.messages set metadata = '{"crm_hidden_at":"2026-11-11"}' where id = '${M.recebida}'`],
    ["apagamento do contato limpa a recebida", `update public.messages set revoked_at = now(), body = null, metadata = '{}' where id = '${M.recebida}'`],
    ["linha da regra antiga é limpa", `update public.messages set body = null, media_storage_path = null where id = '${M.legadoApagada}'`],
    ["marcador da LGPD na recebida apagada", `update public.messages set body = '[mensagem anonimizada]', metadata = '{}' where id = '${M.recebidaApagada}'`],
    ["status de recebida apagada (ack tardio)", `update public.messages set status = 'read' where id = '${M.recebidaApagada}'`],
    ["enviada apagada segue editável no status", `update public.messages set status = 'read' where id = '${M.enviadaApagada}'`],
  ];
  for (const [nome, dml] of LEGITIMAS) {
    it(`service role — ${nome}: aceito`, () => {
      semearMensagens();
      expect(comoServidor(dml)).toBe("ok");
    });
  }

  // ── o que ninguém pode, nem o servidor, nem o dono ──
  const PROIBIDAS: Array<[string, string, RegExp]> = [
    ["desfazer o apagamento", `update public.messages set revoked_at = null where id = '${M.recebidaApagada}'`, /apagamento não se desfaz/],
    ["desfazer o apagamento da ENVIADA", `update public.messages set revoked_at = null where id = '${M.enviadaApagada}'`, /apagamento não se desfaz/],
    ["devolver texto à recebida apagada", `update public.messages set body = 'RESTAURADO' where id = '${M.recebidaApagada}'`, /não recebe texto/],
    ["regravar a mídia (worker atrasado)", `update public.messages set media_storage_path = 'org/x/y.jpg', media_url = 'https://x' where id = '${M.recebidaApagada}'`, /não recebe mídia/],
    ["regravar a transcrição", `update public.messages set media_derived_text = 'o que o áudio dizia' where id = '${M.recebidaApagada}'`, /não recebe mídia/],
    ["trocar a mídia da linha antiga por outra", `update public.messages set media_storage_path = 'org/x/outra.jpg' where id = '${M.legadoApagada}'`, /não recebe mídia/],
    ["apagar e escrever outro texto na mesma escrita", `update public.messages set revoked_at = now(), body = 'outro' where id = '${M.recebida}'`, /não recebe texto/],
    ["mover para outra organização", `update public.messages set organization_id = '${ORG_B}' where id = '${M.recebida}'`, /organization_id não muda/],
    ["trocar a direção", `update public.messages set direction = 'outbound' where id = '${M.recebida}'`, /direction não muda/],
  ];
  for (const [nome, dml, motivo] of PROIBIDAS) {
    it(`service role — ${nome}: recusado`, () => {
      semearMensagens();
      expect(comoServidor(dml)).toMatch(motivo);
    });
  }

  it("o DONO do banco também não desfaz o apagamento (o trigger não depende de papel)", () => {
    semearMensagens();
    expect(comoServidor(`update public.messages set revoked_at = null where id = '${M.recebidaApagada}'`, "postgres")).toMatch(
      /apagamento não se desfaz/,
    );
    expect(campo(M.recebidaApagada, "revoked_at")).not.toBe("<nulo>");
  });

  it("a recusa é estrutural (23514): o canal não fica reentregando uma escrita proibida", () => {
    semearMensagens();
    let m = "";
    try {
      sql(`set role service_role; update public.messages set revoked_at = null where id = '${M.recebidaApagada}';`);
    } catch (err) {
      m = motivoDoErro(err);
    }
    expect(m).toMatch(/messages_imutavel/);
    expect(
      sql(`
        do $t$ begin
          update public.messages set revoked_at = null where id = '${M.recebidaApagada}';
        exception when check_violation then raise notice 'codigo=23514';
        end $t$;
        select 'fim';
      `),
    ).toMatch(/fim$/);
  });
});
