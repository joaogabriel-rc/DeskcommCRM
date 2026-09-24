import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dublados: a REDE (fetch), o PAPEL de quem chama e a auditoria. O resto é de
// verdade — conexão, credencial (`resolveMetaCreds`, decifrando pela RPC),
// espelho e catálogo — sobre um banco que APLICA cada filtro.
const admin = vi.hoisted(() => ({ db: {} as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.db }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/meta/template-sync", () => ({
  syncTemplates: vi.fn(async () => ({ inserted: 0, updated: 0, unchanged: 0, disabled: 0 })),
}));

import { POST } from "@/app/api/v1/channels/templates/route";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { listarModelos, resolverModelo } from "@/lib/channels/catalogo-de-modelos";
import { conferirDefinicao } from "@/lib/channels/conferir-definicao";
import { hashContract } from "@/lib/channels/meta/contract-hash";
import { criarModeloOficial } from "@/lib/channels/meta/criar-modelo";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { metaCloudTemplateOps, validarRascunhoOficial } from "@/lib/channels/meta/templates";
import { montarComponents } from "@/lib/channels/template-conteudo";
import type { ChannelTemplateDraft } from "@/lib/channels/types";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * CRIAR UM MODELO OFICIAL PELO CRM (G1).
 *
 * O modelo nasce NA META, pela conta da conexão escolhida, e o CRM espelha o que
 * ela respondeu: PENDING, com o id que ela deu (`provider_template_id`). Nunca
 * APPROVED por conta própria, nunca na conta de outra organização, e nunca
 * utilizável em Fluxos ou Disparos antes de a Meta aprovar.
 */

const ORG_A = "0395aaaa-0000-4000-8000-000000000001";
const ORG_B = "0395bbbb-0000-4000-8000-000000000002";
const SA = "0395aaaa-5555-4000-8000-000000000001"; // oficial da A, WABA 111, com token
const SA_SEM_TOKEN = "0395aaaa-5555-4000-8000-000000000002"; // oficial da A, WABA 333, sem token
const SA_SEM_WABA = "0395aaaa-5555-4000-8000-000000000003";
const SA_ARQUIVADA = "0395aaaa-5555-4000-8000-000000000004";
const SA_PARCEIRO = "0395aaaa-5555-4000-8000-000000000005";
const SB = "0395bbbb-5555-4000-8000-000000000001"; // oficial da B, WABA 222

const COMPONENTES = montarComponents({
  body: "Olá {{1}}, seu pedido {{2}} saiu.",
  exemplos: ["Ana", "123"],
  footer: "Loja A",
  cabecalho: { texto: "Pedido" },
  botoes: [
    { tipo: "quick_reply", texto: "Recebi" },
    { tipo: "url", texto: "Ver pedido", url: "https://loja.test/p" },
  ],
});

const RASCUNHO: ChannelTemplateDraft = {
  name: "pedido_saiu",
  language: "pt_BR",
  category: "UTILITY",
  components: COMPONENTES,
};

function sessao(o: Record<string, unknown>) {
  return {
    provider: "meta_cloud",
    display_name: null,
    phone_number: null,
    archived_at: null,
    meta_token_encrypted: null,
    created_at: "2026-09-01",
    ...o,
  };
}

let banco: BancoEmMemoria;
let rede: ReturnType<typeof vi.fn>;

function respostaDaMeta(corpo: unknown, status = 200) {
  rede.mockResolvedValue(new Response(JSON.stringify(corpo), { status }));
}

beforeEach(() => {
  banco = criarBanco(
    {
      channel_sessions: [
        sessao({ id: SA, organization_id: ORG_A, meta_waba_id: "111", meta_phone_number_id: "900111", meta_token_encrypted: "\\xA", display_name: "Loja A" }),
        sessao({ id: SA_SEM_TOKEN, organization_id: ORG_A, meta_waba_id: "333", meta_phone_number_id: "900333" }),
        sessao({ id: SA_SEM_WABA, organization_id: ORG_A, meta_waba_id: null, meta_phone_number_id: "900444", meta_token_encrypted: "\\xA" }),
        sessao({ id: SA_ARQUIVADA, organization_id: ORG_A, meta_waba_id: "555", meta_phone_number_id: "900555", meta_token_encrypted: "\\xA", archived_at: "2026-09-10" }),
        sessao({ id: SA_PARCEIRO, organization_id: ORG_A, provider: "datafy", meta_waba_id: null, meta_phone_number_id: null }),
        sessao({ id: SB, organization_id: ORG_B, meta_waba_id: "222", meta_phone_number_id: "900222", meta_token_encrypted: "\\xB" }),
      ],
      meta_templates: [],
    },
    {
      fn_decrypt_oauth: (args) => ({ "\\xA": "tok-da-A", "\\xB": "tok-da-B" })[String(args.ciphertext)] ?? null,
    },
  );
  admin.db = banco.client;
  rede = vi.fn();
  respostaDaMeta({ id: "987654321", status: "PENDING", category: "UTILITY" });
  vi.stubGlobal("fetch", rede);
  // Sem reserva no ambiente: a credencial só pode vir da sessão.
  vi.stubEnv("META_PHONE_NUMBER_ID", "");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
  vi.mocked(audit).mockClear();
  vi.mocked(syncTemplates).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const db = () => banco.client as unknown as SupabaseClient;
const criar = (o: Partial<{ org: string; sessao: string; draft: ChannelTemplateDraft }> = {}) =>
  criarModeloOficial(db(), {
    organizationId: o.org ?? ORG_A,
    channelSessionId: o.sessao ?? SA,
    draft: o.draft ?? RASCUNHO,
  });
const linhas = () => banco.tabelas.meta_templates ?? [];

describe("criar pela Meta: o pedido", () => {
  it("sai para a conta DA CONEXÃO, com o token dela, e com nome, idioma, categoria e componentes", async () => {
    await criar();
    expect(rede).toHaveBeenCalledTimes(1);
    const [url, init] = rede.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/111\/message_templates$/);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-da-A");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "pedido_saiu",
      language: "pt_BR",
      category: "UTILITY",
      components: COMPONENTES,
    });
  });

  it("os valores levam o exemplo que a revisão exige, no formato da Meta", () => {
    const corpo = (COMPONENTES as Array<Record<string, unknown>>).find((c) => c.type === "BODY")!;
    expect(corpo.example).toEqual({ body_text: [["Ana", "123"]] });
  });
});

describe("criar pela Meta: o espelho", () => {
  it("grava PENDING, o provider_template_id e a forma do sync oficial (por conta, sem conexão)", async () => {
    const r = await criar();
    expect(linhas()).toHaveLength(1);
    const l = linhas()[0]!;
    expect(l).toMatchObject({
      organization_id: ORG_A,
      waba_id: "111",
      name: "pedido_saiu",
      language: "pt_BR",
      status: "PENDING",
      category: "UTILITY",
      provider_template_id: "987654321",
      parameter_format: "POSITIONAL",
      contract_hash: hashContract(COMPONENTES, "POSITIONAL"),
    });
    expect(l.channel_session_id ?? null).toBeNull();
    // O id local continua o uuid do espelho; o da Meta vai ao lado.
    expect(r.modelo.id).toBe(l.id);
    expect(r.modelo.id).not.toBe("987654321");
    expect(r.providerTemplateId).toBe("987654321");
    expect(r.modelo.status).toBe("PENDING");
    expect(r.modelo.utilizavel).toBe(false);
  });

  it("sem status na resposta, fica PENDING — nunca APPROVED presumido", async () => {
    respostaDaMeta({ id: "111222" });
    const r = await criar();
    expect(r.modelo.status).toBe("PENDING");
    expect(linhas()[0]!.status).toBe("PENDING");
  });

  it("o estado gravado é o que a Meta respondeu, qualquer que seja", async () => {
    respostaDaMeta({ id: "111333", status: "REJECTED" });
    const r = await criar();
    expect(r.modelo.status).toBe("REJECTED");
  });

  it("recriar o mesmo nome e idioma atualiza a linha no lugar (a chave do sync), sem duplicar", async () => {
    await criar();
    respostaDaMeta({ id: "555666", status: "PENDING" });
    await criar();
    expect(linhas()).toHaveLength(1);
    expect(linhas()[0]!.provider_template_id).toBe("555666");
  });
});

describe("criar pela Meta: o catálogo não o trata como aprovado", () => {
  it("fora da lista de utilizáveis, visível com 'todos', e recusado no pré-voo do envio", async () => {
    await criar();
    const utilizaveis = await listarModelos(db(), { organizationId: ORG_A, somenteUtilizaveis: true });
    expect(utilizaveis).toEqual([]);
    const todos = await listarModelos(db(), { organizationId: ORG_A, channelSessionId: SA });
    expect(todos.map((m) => [m.name, m.status, m.utilizavel])).toEqual([["pedido_saiu", "PENDING", false]]);
    const resolvido = await resolverModelo(db(), ORG_A, { name: "pedido_saiu", language: "pt_BR", channelSessionId: SA });
    expect(resolvido?.utilizavel).toBe(false);
    await expect(
      conferirDefinicao(db(), {
        organizationId: ORG_A,
        channelSessionId: SA,
        name: "pedido_saiu",
        language: "pt_BR",
        values: { "1": "Ana", "2": "1" },
      }),
    ).rejects.toThrow(/template_not_approved.*PENDING/s);
  });

  it("o modelo criado na A nunca aparece no catálogo da B", async () => {
    await criar();
    expect(await listarModelos(db(), { organizationId: ORG_B })).toEqual([]);
    expect(await listarModelos(db(), { organizationId: ORG_B, channelSessionId: SB })).toEqual([]);
    // Nem pedindo, pela B, a conexão da A.
    expect(await listarModelos(db(), { organizationId: ORG_B, channelSessionId: SA })).toEqual([]);
  });
});

describe("criar pela Meta: organização, conta e credencial", () => {
  it("a organização A não cria pela conexão da B — nada sai para a Meta, nada é gravado", async () => {
    // A frase EXATA da primeira porta (a conexão escolhida, conferida contra a
    // organização): a segunda porta (o adapter, pelo par organização + número)
    // também recusaria, e sem fixar qual recusou, tirar a primeira passaria.
    await expect(criar({ sessao: SB })).rejects.toThrow(
      "meta_template_conexao: escolha uma conexão oficial desta organização.",
    );
    expect(rede).not.toHaveBeenCalled();
    expect(linhas()).toEqual([]);
  });

  it("o número da A não alcança a conta da B: pedir o número da B pela A não casa conexão", async () => {
    await expect(
      metaCloudTemplateOps.create({ organizationId: ORG_A, sessionRef: "900222", draft: RASCUNHO }),
    ).rejects.toThrow(/^meta_template_conexao/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("a segunda porta (o adapter) também recusa sozinha: número sem conta, número de outra organização", async () => {
    await expect(
      metaCloudTemplateOps.create({ organizationId: ORG_A, sessionRef: "900444", draft: RASCUNHO }),
    ).rejects.toThrow("meta_template_sem_waba: a conexão não tem conta do WhatsApp Business (WABA) gravada.");
    await expect(
      metaCloudTemplateOps.create({ organizationId: ORG_B, sessionRef: "900111", draft: RASCUNHO }),
    ).rejects.toThrow("meta_template_conexao: esta conexão oficial não é desta organização ou foi excluída.");
    expect(rede).not.toHaveBeenCalled();
  });

  it("conexão da A sem token não usa a credencial da B — recusa como canal não configurado", async () => {
    await expect(criar({ sessao: SA_SEM_TOKEN })).rejects.toThrow(/^meta_not_configured/);
    expect(rede).not.toHaveBeenCalled();
  });

  it("com a reserva do ambiente, a conexão sem token usa o AMBIENTE, nunca o token de outra organização", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "900999");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-do-ambiente");
    await criar({ sessao: SA_SEM_TOKEN });
    const [url, init] = rede.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain("/333/message_templates");
    expect(init.headers.Authorization).toBe("Bearer tok-do-ambiente");
  });

  it("conexão sem conta (WABA), arquivada ou de parceiro: recusa antes da Meta", async () => {
    await expect(criar({ sessao: SA_SEM_WABA })).rejects.toThrow(
      "meta_template_sem_waba: a conexão escolhida não tem conta do WhatsApp Business (WABA) gravada.",
    );
    await expect(criar({ sessao: SA_ARQUIVADA })).rejects.toThrow(/^meta_template_conexao/);
    await expect(criar({ sessao: SA_PARCEIRO })).rejects.toThrow(/^meta_template_conexao/);
    expect(rede).not.toHaveBeenCalled();
    expect(linhas()).toEqual([]);
  });
});

describe("criar pela Meta: quando a Meta recusa ou não responde", () => {
  it("recusa da revisão: o motivo da Meta chega inteiro, e nada é gravado", async () => {
    respostaDaMeta(
      {
        error: {
          code: 100,
          error_subcode: 2388024,
          message: "Invalid parameter",
          error_user_msg: "Já existe um modelo com este nome neste idioma.",
        },
      },
      400,
    );
    await expect(criar()).rejects.toThrow(
      /^meta_template_rejeitado: \(100\/2388024\) Já existe um modelo com este nome neste idioma\.$/,
    );
    expect(linhas()).toEqual([]);
  });

  it("token vencido é erro de CREDENCIAL", async () => {
    respostaDaMeta({ error: { code: 190, message: "Error validating access token" } }, 401);
    await expect(criar()).rejects.toThrow(/^meta_template_credencial: \(190\) Error validating access token/);
    expect(linhas()).toEqual([]);
  });

  it("conta que não existe ou que o token não alcança é erro de WABA", async () => {
    respostaDaMeta({ error: { code: 100, error_subcode: 33, message: "Unsupported post request." } }, 400);
    await expect(criar()).rejects.toThrow(/^meta_template_waba:/);
    respostaDaMeta({ error: { code: 200, message: "Permissions error" } }, 403);
    await expect(criar()).rejects.toThrow(/^meta_template_waba:/);
    expect(linhas()).toEqual([]);
  });

  it("timeout ou rede: erro de REDE, e nada é gravado", async () => {
    rede.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(criar()).rejects.toThrow(/^meta_template_rede: .*timeout/);
    rede.mockRejectedValue(new TypeError("fetch failed"));
    await expect(criar()).rejects.toThrow(/^meta_template_rede: .*fetch failed/);
    expect(linhas()).toEqual([]);
  });

  it("aceito sem id: não inventa registro", async () => {
    respostaDaMeta({ status: "PENDING" });
    await expect(criar()).rejects.toThrow(/^meta_template_rejeitado:/);
    expect(linhas()).toEqual([]);
  });

  it("a Meta criou e o espelho falhou: o erro diz as duas coisas, com o id", async () => {
    const real = banco.client as unknown as { from: (t: string) => unknown };
    const comEspelhoQuebrado = {
      ...real,
      rpc: (banco.client as unknown as { rpc: unknown }).rpc,
      from: (t: string) =>
        t === "meta_templates"
          ? { upsert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "disco cheio" } }) }) }) }
          : real.from(t),
    } as unknown as SupabaseClient;
    await expect(
      criarModeloOficial(comEspelhoQuebrado, { organizationId: ORG_A, channelSessionId: SA, draft: RASCUNHO }),
    ).rejects.toThrow(/^meta_template_espelho: o modelo foi criado na Meta \(id 987654321\).*disco cheio/);
  });
});

describe("criar pela Meta: validação local, antes de qualquer rede", () => {
  const com = (o: Partial<ChannelTemplateDraft>) => ({ ...RASCUNHO, ...o });

  it.each([
    ["cabeçalho de imagem (a Meta exige o upload dela)", com({ components: montarComponents({ body: "Oi", exemplos: [], cabecalho: { midiaUrl: "https://x.test/a.png" } }) }), /imagem, vídeo ou documento/],
    ["nome com maiúscula e espaço", com({ name: "Pedido Saiu" }), /letras minúsculas/],
    ["valor com buraco na numeração", com({ components: [{ type: "BODY", text: "Oi {{1}} {{3}}", example: { body_text: [["a", "b", "c"]] } }] }), /sem pular/],
    ["valor sem exemplo", com({ components: [{ type: "BODY", text: "Oi {{1}}" }] }), /exemplo de cada valor/],
    ["sem corpo", com({ components: [{ type: "FOOTER", text: "x" }] }), /texto de mensagem/],
    ["botão de link sem https", com({ components: montarComponents({ body: "Oi", exemplos: [], botoes: [{ tipo: "url", texto: "Ver", url: "http://x.test" }] }) }), /https/],
    ["rodapé com valor", com({ components: [{ type: "BODY", text: "Oi" }, { type: "FOOTER", text: "{{1}}" }] }), /rodapé não aceita/],
    ["valores nomeados", com({ parameterFormat: "NAMED" }), /numerados/],
  ])("%s", async (_nome, draft, motivo) => {
    expect(validarRascunhoOficial(draft)).toMatch(motivo);
    await expect(criar({ draft })).rejects.toThrow(/^meta_template_validacao:/);
    expect(rede).not.toHaveBeenCalled();
    expect(linhas()).toEqual([]);
  });

  it("o rascunho que o formulário monta passa", () => {
    expect(validarRascunhoOficial(RASCUNHO)).toBeNull();
  });
});

describe("a rota POST /api/v1/channels/templates", () => {
  const pedir = (corpo?: unknown) =>
    POST(
      new NextRequest("http://localhost:3000/api/v1/channels/templates", {
        method: "POST",
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      }),
    );
  const CORPO = {
    acao: "criar",
    channel_session_id: SA,
    name: "pedido_saiu",
    language: "pt_BR",
    category: "UTILITY",
    components: COMPONENTES,
  };

  it("cria na organização da SESSÃO — um organization_id no corpo é ignorado", async () => {
    const res = await pedir({ ...CORPO, organization_id: ORG_B });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { data: { modelo: { status: string; utilizavel: boolean }; provider_template_id: string } };
    expect(j.data.modelo).toMatchObject({ status: "PENDING", utilizavel: false });
    expect(j.data.provider_template_id).toBe("987654321");
    expect(linhas().map((l) => l.organization_id)).toEqual([ORG_A]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", organizationId: ORG_A, resourceId: SA }),
    );
  });

  it("a conexão de outra organização responde 404 e não chama a Meta", async () => {
    const res = await pedir({ ...CORPO, channel_session_id: SB });
    expect(res.status).toBe(404);
    expect(rede).not.toHaveBeenCalled();
  });

  it("corpo incompleto é 422; recusa da Meta é 502 com a frase dela; rede é 504", async () => {
    expect((await pedir({ acao: "criar", name: "x" })).status).toBe(422);
    respostaDaMeta({ error: { code: 100, message: "Invalid parameter" } }, 400);
    const recusa = await pedir(CORPO);
    expect(recusa.status).toBe(502);
    expect(((await recusa.json()) as { error: { message: string } }).error.message).toMatch(/Invalid parameter/);
    rede.mockRejectedValue(new TypeError("fetch failed"));
    expect((await pedir(CORPO)).status).toBe(504);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem corpo (o botão de sincronizar), continua sincronizando — e não cria nada", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(syncTemplates).toHaveBeenCalledTimes(1);
    expect(rede).not.toHaveBeenCalled();
    expect(linhas()).toEqual([]);
  });
});
