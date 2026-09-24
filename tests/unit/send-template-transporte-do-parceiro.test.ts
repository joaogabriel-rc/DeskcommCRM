import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn() }));

import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";

import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * Modelo pelo canal parceiro Graph-compatível (recorte do #1130): com transporte
 * explícito, sai pelo host e token do PARCEIRO — nunca pela credencial da Meta —
 * e confere a definição da conexão dona dela.
 */
const CORPO = [{ type: "BODY", text: "Olá, tudo bem?" }];
const modelo = (o: Record<string, unknown>) => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  organization_id: "org-1",
  waba_id: "999",
  channel_session_id: "sess-1",
  name: "boas_vindas",
  language: "pt_BR",
  status: "APPROVED",
  category: "UTILITY",
  parameter_format: "POSITIONAL",
  contract_hash: "h",
  components: CORPO,
  synced_at: "2026-09-20",
  ...o,
});

// Banco que APLICA os filtros: a conexão do parceiro e a oficial espelham o
// mesmo nome e idioma. Só a linha da conexão do parceiro serve — a oficial
// está pausada, e o envio passaria a recusar se a escolhesse.
let db: SupabaseClient;
beforeEach(() => {
  db = criarBanco({
    channel_sessions: [
      { id: "sess-1", organization_id: "org-1", provider: "datafy", meta_waba_id: null, archived_at: null },
      { id: "sess-oficial", organization_id: "org-1", provider: "meta_cloud", meta_waba_id: "111", archived_at: null },
    ],
    meta_templates: [
      modelo({}),
      modelo({ channel_session_id: null, waba_id: "111", status: "PAUSED", synced_at: "2026-09-23" }),
    ],
  }).client as unknown as SupabaseClient;
});

const ENVIO = {
  organizationId: "org-1",
  sessionRef: "PN",
  to: "5531999998888",
  name: "boas_vindas",
  language: "pt_BR",
  values: {},
  channelSessionId: "sess-1",
  transport: {
    phoneNumberId: "PN",
    token: "sk_live_parceiro",
    graphBase: "https://cloud.example.test/v1",
    errorPrefix: "datafy",
  },
};

beforeEach(() => {
  vi.mocked(resolveMetaCreds).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("modelo com transporte do parceiro", () => {
  it("sai pelo host e token do parceiro, sem consultar a credencial da Meta", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.P" }] }), { status: 200 }));

    expect(await sendTemplateForSession(db, ENVIO)).toBe("wamid.P");

    expect(resolveMetaCreds).not.toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.test/v1/PN/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_parceiro");
    // A definição usada é a da conexão do parceiro (a oficial, pausada, não).
    expect(JSON.parse(String(init?.body)).template.name).toBe("boas_vindas");
  });

  it("a recusa da plataforma sobe com o prefixo do canal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 132001, message: "template does not exist" } }), { status: 400 }),
    );
    await expect(sendTemplateForSession(db, ENVIO)).rejects.toThrow(/^datafy_132001/);
  });
});
