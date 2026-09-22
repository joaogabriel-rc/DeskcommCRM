/**
 * O `state` do Cadastro Incorporado da Meta: assinado, com prazo, amarrado à
 * organização e à pessoa, e de chave SEPARADA do `state` da Agenda do Google — os
 * dois usam a mesma construção e o mesmo `INTERNAL_SECRET`.
 */
import { describe, expect, it } from "vitest";

import { emitirEstado } from "@/lib/agenda/google/estado";
import {
  VALIDADE_DO_ESTADO_DO_CADASTRO_MS,
  emitirEstadoDoCadastro,
  verificarEstadoDoCadastro,
} from "@/lib/channels/meta/estado-do-cadastro";

const SEGREDO = "segredo-interno-de-teste-com-32-chars";
const AGORA = new Date("2026-09-22T12:00:00.000Z");
const DADOS = { organizationId: "org-a", userId: "user-a" };

describe("state do Cadastro Incorporado", () => {
  it("volta com a organização e a pessoa que o emitiram", () => {
    const state = emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA });
    const lido = verificarEstadoDoCadastro(state, { segredo: SEGREDO, agora: AGORA });
    expect(lido?.organizationId).toBe("org-a");
    expect(lido?.userId).toBe("user-a");
    expect(lido?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(lido?.expiraEmMs).toBe(AGORA.getTime() + VALIDADE_DO_ESTADO_DO_CADASTRO_MS);
  });

  it("dois states seguidos têm nonces diferentes (a queima é por nonce)", () => {
    const a = verificarEstadoDoCadastro(emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA }), {
      segredo: SEGREDO,
      agora: AGORA,
    });
    const b = verificarEstadoDoCadastro(emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA }), {
      segredo: SEGREDO,
      agora: AGORA,
    });
    expect(a?.nonce).not.toBe(b?.nonce);
  });

  it("recusa depois do prazo e aceita até o último milissegundo", () => {
    const state = emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA });
    const noLimite = new Date(AGORA.getTime() + VALIDADE_DO_ESTADO_DO_CADASTRO_MS);
    const depois = new Date(noLimite.getTime() + 1);
    expect(verificarEstadoDoCadastro(state, { segredo: SEGREDO, agora: noLimite })).not.toBeNull();
    expect(verificarEstadoDoCadastro(state, { segredo: SEGREDO, agora: depois })).toBeNull();
  });

  it("recusa state adulterado (trocar a organização quebra a assinatura)", () => {
    const state = emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA });
    const [carga, assinatura] = state.split(".");
    const outra = Buffer.from(
      Buffer.from(carga!, "base64url").toString("utf8").replace("org-a", "org-b"),
      "utf8",
    ).toString("base64url");
    expect(verificarEstadoDoCadastro(`${outra}.${assinatura}`, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("recusa state assinado com outro segredo", () => {
    const state = emitirEstadoDoCadastro(DADOS, { segredo: SEGREDO, agora: AGORA });
    expect(
      verificarEstadoDoCadastro(state, { segredo: "outro-segredo-de-instalacao-32ch", agora: AGORA }),
    ).toBeNull();
  });

  it("um state da Agenda do Google NÃO vale aqui, mesmo com o mesmo INTERNAL_SECRET", () => {
    const doGoogle = emitirEstado(DADOS, { segredo: SEGREDO, agora: AGORA });
    expect(verificarEstadoDoCadastro(doGoogle, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("recusa emitir e verificar com INTERNAL_SECRET ausente ou curto (não deriva chave forte de segredo fraco)", () => {
    expect(() => emitirEstadoDoCadastro(DADOS, { segredo: "", agora: AGORA })).toThrow(/INTERNAL_SECRET/);
    expect(() => emitirEstadoDoCadastro(DADOS, { segredo: "curto", agora: AGORA })).toThrow(/INTERNAL_SECRET/);
    expect(() => verificarEstadoDoCadastro("x.y", { segredo: "curto", agora: AGORA })).toThrow(/INTERNAL_SECRET/);
  });

  it("vazio, lixo e formato errado são recusas, não exceções", () => {
    for (const lixo of [null, undefined, "", "sem-ponto", "a.b.c", "%%%.zz"]) {
      expect(verificarEstadoDoCadastro(lixo, { segredo: SEGREDO, agora: AGORA })).toBeNull();
    }
  });
});
