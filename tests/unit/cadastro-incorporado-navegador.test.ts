/**
 * O que o navegador ACEITA ouvir do Cadastro Incorporado da Meta: origem na lista
 * exata (nunca `endsWith('facebook.com')`) e payload `WA_EMBEDDED_SIGNUP` válido.
 * E as opções com que o fluxo v4 é aberto.
 */
import { describe, expect, it, vi } from "vitest";

import {
  abrirCadastroDaMeta,
  lerMensagemDoCadastro,
  origemDaMetaAceita,
  type SdkDaMeta,
} from "@/lib/channels/meta/cadastro-incorporado-navegador";

const META = "https://www.facebook.com";

function msg(event: string, data: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data });
}

describe("origem", () => {
  it.each(["https://www.facebook.com", "https://web.facebook.com", "https://business.facebook.com"])(
    "aceita %s",
    (o) => expect(origemDaMetaAceita(o)).toBe(true),
  );

  it.each([
    "https://evilfacebook.com",
    "https://www.facebook.com.evil.com",
    "http://www.facebook.com",
    "https://facebook.com.br",
    "https://m.facebook.com",
    "null",
    "",
  ])("recusa %s", (o) => {
    expect(origemDaMetaAceita(o)).toBe(false);
    expect(lerMensagemDoCadastro(o, msg("FINISH", { waba_id: "200000000000001" }))).toBeNull();
  });
});

describe("payload WA_EMBEDDED_SIGNUP", () => {
  it("FINISH traz evento, WABA e número", () => {
    expect(
      lerMensagemDoCadastro(
        META,
        msg("FINISH", { waba_id: "200000000000001", phone_number_id: "100000000000001", business_id: "300000000000001" }),
      ),
    ).toEqual({ tipo: "concluido", evento: "FINISH", wabaId: "200000000000001", phoneNumberId: "100000000000001" });
  });

  it.each(["FINISH_ONLY_WABA", "FINISH_GRANT_ONLY_API_ACCESS", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_OBO_MIGRATION"])(
    "%s é conclusão (o servidor decide se suporta)",
    (evento) => {
      expect(lerMensagemDoCadastro(META, msg(evento, { waba_id: "200000000000001" }))).toMatchObject({
        tipo: "concluido",
        evento,
      });
    },
  );

  it("CANCEL com current_step é desistência", () => {
    expect(lerMensagemDoCadastro(META, msg("CANCEL", { current_step: "PHONE_NUMBER_SETUP" }))).toEqual({
      tipo: "cancelado",
      passo: "PHONE_NUMBER_SETUP",
    });
  });

  it("CANCEL com error_message é ERRO (o formato documentado da v4)", () => {
    expect(
      lerMensagemDoCadastro(META, msg("CANCEL", { error_message: "falhou", error_code: "524126", session_id: "s" })),
    ).toEqual({ tipo: "erro", codigo: "524126" });
  });

  it("ERROR também é erro", () => {
    expect(lerMensagemDoCadastro(META, msg("ERROR", { error_code: "1" }))).toMatchObject({ tipo: "erro" });
  });

  it("aceita o payload já como objeto", () => {
    expect(lerMensagemDoCadastro(META, { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} })).toEqual({
      tipo: "cancelado",
      passo: undefined,
    });
  });

  it("id que não é só dígitos é descartado (não vira sugestão)", () => {
    expect(
      lerMensagemDoCadastro(META, msg("FINISH", { waba_id: "<script>", phone_number_id: 123 })),
    ).toEqual({ tipo: "concluido", evento: "FINISH", wabaId: undefined, phoneNumberId: undefined });
  });

  it("ignora mensagens que não são do cadastro — inclusive as internas do SDK", () => {
    for (const dado of [
      "cb=f123&code=AQBsegredo&origin=x", // mensagem interna do SDK, não-JSON
      JSON.stringify({ type: "OUTRA_COISA", event: "FINISH" }),
      msg("EVENTO_INVENTADO"),
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP" }),
      null,
      42,
    ]) {
      expect(lerMensagemDoCadastro(META, dado)).toBeNull();
    }
  });
});

describe("abertura do fluxo v4", () => {
  it("chama FB.login com config_id, response_type code e override, SEM sessionInfoVersion", () => {
    const login = vi.fn();
    const sdk: SdkDaMeta = { init: vi.fn(), login };
    const aoVoltar = vi.fn();
    abrirCadastroDaMeta(sdk, "3333344444", aoVoltar);

    expect(login).toHaveBeenCalledTimes(1);
    const [callback, opcoes] = login.mock.calls[0]!;
    expect(opcoes).toEqual({
      config_id: "3333344444",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    });
    expect(JSON.stringify(opcoes)).not.toContain("sessionInfoVersion");
    // O SDK recusa callback `async`: tem de ser função comum.
    expect(callback.constructor.name).toBe("Function");
    callback({ authResponse: { code: "c" } });
    expect(aoVoltar).toHaveBeenCalledWith({ authResponse: { code: "c" } });
  });
});
