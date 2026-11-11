/**
 * Migration 9332: o `authenticated` perdeu o UPDATE em `messages`, então as
 * rotas que atualizam mensagem autorizam pela SESSÃO e gravam pelo service role.
 *
 * Os testes de handler trocam `clienteDeEscritaDeMensagens` por um repasse da
 * sessão (para conferir as escritas no mesmo banco falso). Este arquivo prova o
 * que aquele repasse esconde:
 *   - em produção a escrita sai pelo service role, NUNCA pelo cliente da sessão;
 *   - nenhuma das três rotas voltou a fazer UPDATE em `messages` pela sessão;
 *   - cada UPDATE pelo service role leva `organization_id` da sessão e as
 *     condições do alvo (autoria, direção, não apagada) — a autorização que a
 *     RLS deixava de dar mora agora no próprio UPDATE;
 *   - a autorização da rota (`requireRole` / `resolveAuthDual` e
 *     `requireSupportWrite`) continua ANTES da escrita.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const doServidor = { papel: "service_role" } as never;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => doServidor }));

import { clienteDeEscritaDeMensagens } from "@/lib/messaging/cliente-de-escrita";

const fonte = (p: string) => readFileSync(p, "utf8");
const HANDLER = "app/api/v1/messages/_handler.ts";
const EDITAR = "app/api/v1/messages/[id]/route.ts";
const OCULTAR = "app/api/v1/messages/[id]/hide/route.ts";

/**
 * Cada UPDATE em `messages` do arquivo, com o cliente que o abre: a cadeia
 * `<cliente>.from("messages").update(` ou o atalho `mensagensDoServidor().update(`
 * do handler, até o `;` que fecha a instrução. A definição do atalho não conta:
 * depois dela vem `;`, não `.update(`.
 */
function updatesDeMensagens(codigo: string): Array<{ cliente: string; trecho: string }> {
  const out: Array<{ cliente: string; trecho: string }> = [];
  const re = /(\w+(?:\([^()]*\))?)\s*\.from\("messages"\)|(mensagensDoServidor)\(\)/g;
  for (let m = re.exec(codigo); m; m = re.exec(codigo)) {
    const resto = codigo.slice(m.index + m[0].length);
    const instrucao = resto.slice(0, resto.indexOf(";"));
    if (!/^\s*\.update\(/.test(instrucao)) continue;
    out.push({ cliente: m[2] ? "mensagensDoServidor()" : m[1]!, trecho: m[0] + instrucao });
  }
  return out;
}

describe("o cliente de escrita de mensagens", () => {
  it("devolve o service role — nunca a sessão que recebeu", () => {
    const sessao = { papel: "authenticated" } as never;
    const c = clienteDeEscritaDeMensagens(sessao);
    expect(c).toBe(doServidor);
    expect(c).not.toBe(sessao);
  });
});

describe("as três rotas não atualizam `messages` pela sessão", () => {
  for (const arquivo of [HANDLER, EDITAR, OCULTAR]) {
    it(`${arquivo}: todo UPDATE em messages sai pelo cliente de escrita`, () => {
      const ups = updatesDeMensagens(fonte(arquivo));
      expect(ups.length, "a sonda não achou UPDATE nenhum — ela ficou cega").toBeGreaterThan(0);
      for (const u of ups) {
        expect(u.cliente, u.trecho.slice(0, 160)).toMatch(/^(clienteDeEscritaDeMensagens\(supabase\)|mensagensDoServidor\(\))$/);
      }
    });
  }

  it("o handler de envio: todo UPDATE pelo servidor leva o organization_id da sessão", () => {
    const ups = updatesDeMensagens(fonte(HANDLER)).filter((u) => u.cliente === "mensagensDoServidor()");
    expect(ups.length).toBe(8);
    for (const u of ups) expect(u.trecho, u.trecho.slice(0, 160)).toContain('.eq("organization_id", ctx.organization_id)');
    expect(fonte(HANDLER)).toContain('const mensagensDoServidor = () => clienteDeEscritaDeMensagens(supabase).from("messages");');
  });

  it("editar/apagar a própria enviada: o UPDATE repete organização, autoria, direção e não-apagada", () => {
    const [u] = updatesDeMensagens(fonte(EDITAR));
    expect(u!.trecho).toContain('.eq("organization_id", authz.org.orgId)');
    expect(u!.trecho).toContain('.eq("sent_by_user_id", authz.user.id)');
    expect(u!.trecho).toContain('.eq("direction", "outbound")');
    expect(u!.trecho).toContain('.is("revoked_at", null)');
  });

  it("ocultar no CRM: o UPDATE repete organização, direção recebida e não-apagada", () => {
    const [u] = updatesDeMensagens(fonte(OCULTAR));
    expect(u!.trecho).toContain('.eq("organization_id", authz.org.orgId)');
    expect(u!.trecho).toContain('.eq("direction", "inbound")');
    expect(u!.trecho).toContain('.is("revoked_at", null)');
  });

  it("a autorização da rota continua ANTES da escrita", () => {
    for (const [arquivo, papel] of [
      [EDITAR, 'requireRole("agent"'],
      [OCULTAR, 'requireRole("manager"'],
    ] as const) {
      const s = fonte(arquivo);
      // dentro de `alterar`, o papel é cobrado antes do UPDATE
      const escrita = s.indexOf("clienteDeEscritaDeMensagens(supabase).from");
      expect(s.indexOf(papel), arquivo).toBeGreaterThan(-1);
      expect(s.indexOf(papel), arquivo).toBeLessThan(escrita);
      // e todo handler exportado barra o suporte só-leitura antes de chamar `alterar`
      const exportados = s.split(/\nexport async function /).slice(1);
      expect(exportados.length, arquivo).toBe(2);
      for (const corpo of exportados) {
        expect(corpo.indexOf("requireSupportWrite()"), arquivo).toBeGreaterThan(-1);
        expect(corpo.indexOf("requireSupportWrite()"), arquivo).toBeLessThan(corpo.indexOf("alterar("));
      }
    }
    const rota = fonte("app/api/v1/messages/route.ts");
    expect(rota).toMatch(/resolveAuthDual\(req, \{[\s\S]*?role: "agent"/);
  });
});
