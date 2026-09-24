import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CredenciaisDoParceiro from "@/lib/channels/graph-parceiro/credentials";

// Só a CREDENCIAL e a REDE são dubladas. A resolução do modelo (catálogo
// central) e o banco que ela lê são de verdade: o banco em memória aplica cada
// filtro, então "o modelo de outra conta não sai" é medido, não suposto.
const admin = vi.hoisted(() => ({ db: {} as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.db }));
vi.mock("@/lib/channels/meta/credentials", () => ({
  resolveMetaCreds: vi.fn(async () => ({ phoneNumberId: "PN-OFICIAL", token: "tok", graphVersion: "v21.0" })),
}));
vi.mock("@/lib/channels/graph-parceiro/credentials", async (original) => ({
  ...(await original<typeof CredenciaisDoParceiro>()),
  resolveGraphPartnerCreds: vi.fn(async () => ({
    channelSessionId: "sessao-parceiro",
    phoneNumberId: "PN-PARCEIRO",
    wabaId: "",
    token: "tok-parceiro",
  })),
}));

import { datafyAdapter } from "@/lib/channels/adapters/datafy";
import { conferirDefinicao } from "@/lib/channels/conferir-definicao";
import { hashContract } from "@/lib/channels/meta/contract-hash";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * O ENVIO DE MODELO RESOLVE A DEFINIÇÃO PELO CATÁLOGO CENTRAL — O MESMO DO PRÉ-VOO.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * O pré-voo (`conferirDefinicao`) já resolvia pelo catálogo (`resolverModelo`):
 * a linha da conexão OU a linha sem conexão da mesma WABA, que é como o sync
 * oficial grava. O envio (`sendTemplateForSession`) tinha a PRÓPRIA busca, que
 * filtrava só `channel_session_id = conexão`. No canal oficial essa coluna vem
 * vazia: o pré-voo aprovava e o envio dizia "não está no espelho". Duas
 * respostas para a mesma pergunta — e a do envio era a errada.
 *
 * Os casos seguem a ordem do handler de mensagens (`app/api/v1/messages/_handler.ts`):
 * pré-voo, depois envio. E há um caso que chama o envio SEM o pré-voo, para
 * provar que o envio, sozinho, também não aceita o que o catálogo recusa.
 */

const ORG_A = "org-a";
const ORG_B = "org-b";
const OFICIAL_A = "sessao-oficial-a"; // WABA 111
const OFICIAL_A2 = "sessao-oficial-a2"; // WABA 222, mesma organização
const OFICIAL_B = "sessao-oficial-b"; // WABA 333, outra organização
const PARCEIRO = "sessao-parceiro";

const CORPO = [{ type: "BODY", text: "Olá {{1}}" }];

function modelo(o: Record<string, unknown>) {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    organization_id: ORG_A,
    waba_id: "111",
    channel_session_id: null, // o formato do sync oficial: por CONTA
    name: "boas",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "POSITIONAL",
    contract_hash: hashContract(CORPO),
    components: CORPO,
    synced_at: "2026-09-20",
    ...o,
  };
}

function banco(modelos: Array<Record<string, unknown>>): SupabaseClient {
  return criarBanco({
    channel_sessions: [
      { id: OFICIAL_A, organization_id: ORG_A, provider: "meta_cloud", meta_waba_id: "111", archived_at: null },
      { id: OFICIAL_A2, organization_id: ORG_A, provider: "meta_cloud", meta_waba_id: "222", archived_at: null },
      { id: OFICIAL_B, organization_id: ORG_B, provider: "meta_cloud", meta_waba_id: "333", archived_at: null },
      { id: PARCEIRO, organization_id: ORG_A, provider: "datafy", meta_waba_id: null, archived_at: null },
    ],
    meta_templates: modelos,
  }).client as unknown as SupabaseClient;
}

let rede: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rede = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
  vi.stubGlobal("fetch", rede);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface Envio {
  org?: string;
  sessao: string | null;
  values?: Record<string, string>;
}

const pedido = (e: Envio) => ({
  organizationId: e.org ?? ORG_A,
  channelSessionId: e.sessao,
  name: "boas",
  language: "pt_BR",
  values: e.values ?? { "1": "Ana" },
});

/** Só o envio — sem o pré-voo na frente. */
const soOEnvio = (db: SupabaseClient, e: Envio) =>
  sendTemplateForSession(db, { ...pedido(e), sessionRef: "PN-OFICIAL", to: "5531999998888" });

/** Na ordem do handler: pré-voo, depois envio. */
async function comoOHandler(db: SupabaseClient, e: Envio) {
  await conferirDefinicao(db, pedido(e));
  return soOEnvio(db, e);
}

describe("envio de modelo resolvido pelo catálogo central", () => {
  it("1 · oficial correto (linha por CONTA, sem conexão gravada): o pré-voo aprova e o envio SAI", async () => {
    // O defeito: aqui o envio antigo lançava template_missing.
    await expect(comoOHandler(banco([modelo({})]), { sessao: OFICIAL_A })).resolves.toBe("wamid.OK");
    expect(rede).toHaveBeenCalledTimes(1);
    const corpo = JSON.parse(String((rede.mock.calls[0] as [string, RequestInit])[1].body));
    // O payload não mudou: nome, idioma e o valor no corpo.
    expect(corpo.template).toEqual({
      name: "boas",
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
    });
  });

  it("2 · modelo de OUTRA WABA da mesma organização: o pré-voo recusa, e o envio sozinho também não sai", async () => {
    const db = banco([modelo({ waba_id: "222" })]);
    await expect(comoOHandler(db, { sessao: OFICIAL_A })).rejects.toThrow(/template_other_account/);
    await expect(soOEnvio(db, { sessao: OFICIAL_A })).rejects.toThrow(/^template_missing/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("3 · modelo de OUTRA organização: nunca sai — nem pelo par nome/idioma, nem pedindo a conexão dela", async () => {
    const db = banco([modelo({ organization_id: ORG_B, waba_id: "333" })]);
    // Para A, a linha de B não existe: o pré-voo deixa passar (espelho sem ela)
    // e o envio recusa antes da rede.
    await expect(comoOHandler(db, { sessao: OFICIAL_A })).rejects.toThrow(/^template_missing/);
    // A pedindo a CONEXÃO da B: a conexão não é desta organização, não resolve.
    await expect(soOEnvio(db, { sessao: OFICIAL_B })).rejects.toThrow(/^template_missing/);
    await expect(soOEnvio(db, { sessao: null })).rejects.toThrow(/^template_missing/);
    expect(rede).not.toHaveBeenCalled();
  });

  it.each(["PAUSED", "REJECTED", "DISABLED"])("4 · modelo %s: o pré-voo recusa, e o envio sozinho também", async (status) => {
    const db = banco([modelo({ status })]);
    await expect(comoOHandler(db, { sessao: OFICIAL_A })).rejects.toThrow(/template_not_approved/);
    await expect(soOEnvio(db, { sessao: OFICIAL_A })).rejects.toThrow(/^template_not_approved/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("5 · modelo inexistente: o envio recusa antes da rede", async () => {
    const db = banco([modelo({ name: "outro" })]);
    await expect(comoOHandler(db, { sessao: OFICIAL_A })).rejects.toThrow(/^template_missing/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("6 · nó com channel_session_id: usa a conta DAQUELE número, mesmo com o par em duas contas", async () => {
    // Mesmo nome e idioma nas duas WABAs; a da 222 está pausada. Pela conexão
    // da 111 o modelo aprovado sai; pela da 222, não.
    const db = banco([modelo({}), modelo({ waba_id: "222", status: "PAUSED", synced_at: "2026-09-23" })]);
    await expect(comoOHandler(db, { sessao: OFICIAL_A })).resolves.toBe("wamid.OK");
    await expect(comoOHandler(db, { sessao: OFICIAL_A2 })).rejects.toThrow(/template_not_approved/);
    expect(rede).toHaveBeenCalledTimes(1);
  });

  it("7 · nó antigo sem channel_session_id: par único na organização sai; par em duas contas não escolhe nenhuma", async () => {
    await expect(comoOHandler(banco([modelo({})]), { sessao: null })).resolves.toBe("wamid.OK");
    expect(rede).toHaveBeenCalledTimes(1);

    const ambiguo = banco([modelo({}), modelo({ waba_id: "222" })]);
    // O pré-voo não sabe qual é (deixa passar); o envio não adivinha — recusa,
    // como o `maybeSingle` antigo recusava com duas linhas.
    await expect(comoOHandler(ambiguo, { sessao: null })).rejects.toThrow(/^template_missing/);
    expect(rede).toHaveBeenCalledTimes(1);
  });

  it("valores faltando: o pré-voo e o envio dizem a mesma coisa", async () => {
    const db = banco([modelo({})]);
    await expect(comoOHandler(db, { sessao: OFICIAL_A, values: {} })).rejects.toThrow(/template_missing_values/);
    await expect(soOEnvio(db, { sessao: OFICIAL_A, values: {} })).rejects.toThrow(/^template_missing_values/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("falha de leitura do espelho vira template_lookup_failed — o prefixo de sempre", async () => {
    const db = {
      from: () => {
        throw new Error("conexão caiu");
      },
    } as unknown as SupabaseClient;
    await expect(soOEnvio(db, { sessao: OFICIAL_A })).rejects.toThrow(/^template_lookup_failed: .*conexão caiu/);
    expect(rede).not.toHaveBeenCalled();
  });
});

describe("8 · canal parceiro Graph-compatível, pelo adapter de verdade", () => {
  beforeEach(() => vi.stubEnv("DATAFY_ENABLED", "true"));

  // O adapter lê o espelho com o admin client — aqui, o banco em memória.
  const peloAdapter = (db: SupabaseClient) => {
    admin.db = db;
    return datafyAdapter.sendTemplate!({
      organizationId: ORG_A,
      sessionRef: "PN-PARCEIRO",
      to: "5531999998888",
      name: "boas",
      language: "pt_BR",
      values: { "1": "Ana" },
    });
  };

  it("a linha gravada COM a conexão do parceiro continua resolvendo — e sai pelo host dele", async () => {
    vi.stubEnv("DATAFY_API_BASE_URL", "https://parceiro.test");
    const db = banco([
      modelo({ channel_session_id: PARCEIRO, waba_id: "999" }),
      // A oficial, com o mesmo par e pausada: não é deste número, não interfere.
      modelo({ status: "PAUSED", synced_at: "2026-09-23" }),
    ]);
    await expect(peloAdapter(db)).resolves.toEqual({ externalId: "wamid.OK" });
    const [url, init] = rede.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://parceiro.test/v1/PN-PARCEIRO/messages");
    expect(init.headers.Authorization).toBe("Bearer tok-parceiro");
  });

  it("modelo só da conta oficial não sai pelo número do parceiro", async () => {
    await expect(peloAdapter(banco([modelo({})]))).rejects.toThrow(/^template_missing/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("modelo do parceiro pausado: recusa antes da rede", async () => {
    const db = banco([modelo({ channel_session_id: PARCEIRO, waba_id: "999", status: "PAUSED" })]);
    await expect(peloAdapter(db)).rejects.toThrow(/^template_not_approved/);
    expect(rede).not.toHaveBeenCalled();
  });
});
