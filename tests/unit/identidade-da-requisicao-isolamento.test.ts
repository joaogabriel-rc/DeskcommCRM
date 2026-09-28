/**
 * Uma validação de usuário por requisição — sem que o usuário (ou a
 * organização) de uma requisição possa aparecer em outra.
 *
 * O `proxy.ts` passou a entregar ao handler o usuário que o `getUser()` dele
 * acabou de validar (`lib/auth/identidade-assinada.ts`), e `loadAuthUser`
 * passou a ser memoizado por requisição também em Route Handler, onde o
 * `cache()` do React é no-op. As duas mudanças só se pagam se forem
 * IMPOSSÍVEIS de cruzar entre tenants — é isso que este arquivo prova:
 *
 *  1. assinatura: forjada, adulterada, vencida, de outro segredo, ou
 *     apresentada com os cookies de OUTRA sessão → recusada;
 *  2. memo: requisições diferentes nunca compartilham resultado, e a mesma
 *     requisição que troca de sessão no meio recalcula;
 *  3. proxy: o cabeçalho que o navegador mandar não chega ao handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

import {
  assinarIdentidade,
  CABECALHO_IDENTIDADE,
  VALIDADE_MS,
  verificarIdentidade,
} from "@/lib/auth/identidade-assinada";

const SEGREDO = "service-role-de-teste-0123456789abcdef";

const USUARIO_A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@a.test", factors: [] } as unknown as User;
const USUARIO_B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "b@b.test", factors: [] } as unknown as User;
const ORG_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ORG_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

const NOME = "sb-deskcomm-auth";
const SESSAO_A = [{ name: NOME, value: "sessao-do-A" }];
const SESSAO_B = [{ name: NOME, value: "sessao-do-B" }];
const COOKIES_A = { nome: NOME, todos: SESSAO_A };
const COOKIES_B = { nome: NOME, todos: SESSAO_B };

describe("identidade assinada pelo proxy", () => {
  it("volta o mesmo usuário quando assinatura, validade e cookies batem", async () => {
    const v = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO);
    expect(v).toBeTruthy();
    expect((await verificarIdentidade(v, COOKIES_A, SEGREDO))?.id).toBe(USUARIO_A.id);
  });

  it("identidade do usuário A apresentada com os cookies do usuário B é RECUSADA", async () => {
    const v = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO);
    expect(await verificarIdentidade(v, COOKIES_B, SEGREDO)).toBeNull();
  });

  it("corpo adulterado para outro usuário, mantida a assinatura, é recusado", async () => {
    const v = (await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO))!;
    const [, corpo, sig] = v.split(".");
    const carga = JSON.parse(Buffer.from(corpo!, "base64url").toString());
    carga.uid = USUARIO_B.id;
    carga.u = USUARIO_B;
    const forjado = `v1.${Buffer.from(JSON.stringify(carga)).toString("base64url")}.${sig}`;
    expect(await verificarIdentidade(forjado, COOKIES_A, SEGREDO)).toBeNull();
  });

  it("assinada com outro segredo é recusada", async () => {
    const v = await assinarIdentidade(USUARIO_A, COOKIES_A, "outro-segredo-qualquer-0000000000");
    expect(await verificarIdentidade(v, COOKIES_A, SEGREDO)).toBeNull();
  });

  it("vencida, ou emitida no futuro, é recusada", async () => {
    const agora = Date.now();
    const velha = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO, agora - VALIDADE_MS - 1);
    const futura = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO, agora + 60_000);
    expect(await verificarIdentidade(velha, COOKIES_A, SEGREDO, agora)).toBeNull();
    expect(await verificarIdentidade(futura, COOKIES_A, SEGREDO, agora)).toBeNull();
  });

  it("sem cookie de sessão não há o que amarrar: nada é assinado nem aceito", async () => {
    expect(await assinarIdentidade(USUARIO_A, { nome: NOME, todos: [] }, SEGREDO)).toBeNull();
    const v = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO);
    expect(await verificarIdentidade(v, { nome: NOME, todos: [] }, SEGREDO)).toBeNull();
  });

  it("cabeçalho escrito à mão pelo navegador é recusado", async () => {
    const carga = { uid: USUARIO_A.id, u: USUARIO_A, iat: Date.now(), b: "x" };
    const manual = `v1.${Buffer.from(JSON.stringify(carga)).toString("base64url")}.AAAA`;
    for (const v of [manual, "v1..", "qualquer coisa", "", null]) {
      expect(await verificarIdentidade(v, COOKIES_A, SEGREDO)).toBeNull();
    }
  });
});

// ── loadAuthUser: memo por requisição, nunca entre requisições ──────────────

/** A "requisição" corrente que o dublê de `next/headers` devolve. */
const req: { headers: Headers; cookies: { name: string; value: string }[] } = {
  headers: new Headers(),
  cookies: SESSAO_A,
};

vi.mock("next/headers", () => ({
  headers: async () => req.headers,
  cookies: async () => ({
    get: (n: string) => req.cookies.find((c) => c.name === n),
    getAll: () => req.cookies,
    set: () => {},
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/env", () => ({
  env: { SUPABASE_SERVICE_ROLE_KEY: SEGREDO, NEXT_PUBLIC_APP_URL: "https://crm.test" },
}));

/** Quantas vezes o GoTrue foi perguntado, e por quem (qual sessão estava no cookie). */
const idasAoGoTrue: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  NOME_DO_COOKIE_DE_SESSAO: "sb-deskcomm-auth",
  createClient: async () => {
    // O cliente real lê o cookie da requisição: o dublê faz o mesmo, e cada
    // sessão só enxerga a SUA organização — como a RLS faria.
    const sessao = req.cookies[0]?.value;
    const ehA = sessao === "sessao-do-A";
    const user = ehA ? USUARIO_A : USUARIO_B;
    const org = ehA ? ORG_A : ORG_B;
    const memberships = {
      data: [{ organization_id: org, role: "admin", organizations: { display_name: ehA ? "Empresa A" : "Empresa B" } }],
      error: null,
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      is: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (r: (v: unknown) => unknown) => Promise.resolve(memberships).then(r),
    });
    return {
      rpc: async () => ({ data: null, error: null }),
      from: () => chain,
      auth: {
        getUser: async () => {
          idasAoGoTrue.push(sessao ?? "sem-sessao");
          return { data: { user }, error: null };
        },
      },
    };
  },
}));

const { loadAuthUser } = await import("@/lib/auth/server");

function novaRequisicao(cookies: { name: string; value: string }[], identidade?: string | null) {
  req.headers = new Headers();
  if (identidade) req.headers.set(CABECALHO_IDENTIDADE, identidade);
  req.cookies = cookies;
}

beforeEach(() => {
  idasAoGoTrue.length = 0;
});

describe("loadAuthUser — contexto por requisição", () => {
  it("duas requisições de tenants diferentes recebem, cada uma, o SEU contexto", async () => {
    novaRequisicao(SESSAO_A);
    const a = await loadAuthUser();
    novaRequisicao(SESSAO_B);
    const b = await loadAuthUser();

    expect(a?.id).toBe(USUARIO_A.id);
    expect(a?.organizations.map((o) => o.organization_id)).toEqual([ORG_A]);
    expect(b?.id).toBe(USUARIO_B.id);
    expect(b?.organizations.map((o) => o.organization_id)).toEqual([ORG_B]);
  });

  it("dentro da MESMA requisição, a segunda chamada não refaz a cadeia", async () => {
    novaRequisicao(SESSAO_A);
    const primeira = await loadAuthUser();
    const segunda = await loadAuthUser();
    expect(segunda).toBe(primeira);
    expect(idasAoGoTrue).toEqual(["sessao-do-A"]);
  });

  it("a mesma requisição que TROCA de sessão no meio recalcula (não serve o contexto antigo)", async () => {
    novaRequisicao(SESSAO_A);
    expect((await loadAuthUser())?.id).toBe(USUARIO_A.id);
    // Mesmo objeto de cabeçalhos (mesma requisição), cookie de sessão trocado —
    // o que um login dentro de uma Server Action faz.
    req.cookies = SESSAO_B;
    const depois = await loadAuthUser();
    expect(depois?.id).toBe(USUARIO_B.id);
    expect(depois?.organizations.map((o) => o.organization_id)).toEqual([ORG_B]);
  });

  it("com a identidade do proxy válida, NÃO vai ao GoTrue", async () => {
    novaRequisicao(SESSAO_A, await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO));
    const u = await loadAuthUser();
    expect(u?.id).toBe(USUARIO_A.id);
    expect(idasAoGoTrue).toEqual([]);
  });

  it("identidade do A reapresentada numa requisição com a sessão do B: ignora e pergunta ao GoTrue", async () => {
    const doA = await assinarIdentidade(USUARIO_A, COOKIES_A, SEGREDO);
    novaRequisicao(SESSAO_B, doA);
    const u = await loadAuthUser();
    expect(u?.id).toBe(USUARIO_B.id);
    expect(u?.organizations.map((o) => o.organization_id)).toEqual([ORG_B]);
    expect(idasAoGoTrue).toEqual(["sessao-do-B"]);
  });
});

// ── proxy: o cabeçalho do navegador nunca chega ao handler ───────────────────

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, opts: { cookies: { getAll: () => { name: string }[] } }) => ({
    auth: {
      getUser: async () => {
        const temSessao = opts.cookies.getAll().some((c) => c.name.startsWith("sb-deskcomm-auth"));
        return { data: { user: temSessao ? USUARIO_A : null }, error: null };
      },
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));

/** O que o Next entregaria ao handler: cabeçalhos `x-middleware-request-*`. */
function encaminhado(res: Response, nome: string): string | null {
  return res.headers.get(`x-middleware-request-${nome}`);
}

describe("proxy — a identidade só nasce no proxy", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");

  it("rota pública: cabeçalho forjado pelo navegador é APAGADO", async () => {
    const r = new NextRequest("https://crm.test/login", {
      headers: { [CABECALHO_IDENTIDADE]: "v1.forjado.forjado" },
    });
    const res = await proxy(r);
    expect(encaminhado(res, CABECALHO_IDENTIDADE)).toBeNull();
  });

  it("rota autenticada: o forjado é trocado pela identidade que o proxy validou", async () => {
    const r = new NextRequest("https://crm.test/api/v1/tags/cores", {
      headers: {
        [CABECALHO_IDENTIDADE]: "v1.forjado.forjado",
        cookie: "sb-deskcomm-auth=sessao-do-A",
      },
    });
    const res = await proxy(r);
    const valor = encaminhado(res, CABECALHO_IDENTIDADE);
    expect(valor).not.toBe("v1.forjado.forjado");
    expect((await verificarIdentidade(valor, COOKIES_A, SEGREDO))?.id).toBe(USUARIO_A.id);
    // E ela não serve para outra sessão.
    expect(await verificarIdentidade(valor, COOKIES_B, SEGREDO)).toBeNull();
  });

  it("sem sessão: 401, e nenhum cabeçalho de identidade encaminhado", async () => {
    const r = new NextRequest("https://crm.test/api/v1/tags/cores", {
      headers: { [CABECALHO_IDENTIDADE]: "v1.forjado.forjado" },
    });
    const res = await proxy(r);
    expect(res.status).toBe(401);
    expect(encaminhado(res, CABECALHO_IDENTIDADE)).toBeNull();
  });
});
