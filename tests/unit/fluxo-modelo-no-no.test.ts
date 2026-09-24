import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * O MODELO APROVADO NO NÓ DE MENSAGEM — escolhido do catálogo, não digitado.
 *
 * Três coisas sob prova:
 *   1. ATIVAR confere o modelo escolhido contra o catálogo (`bindingState`, a
 *      régua que o produto já usa): não localizado, não aprovado, MUDOU desde a
 *      escolha, e espaço sem valor — cada um barra com a frase que diz o quê;
 *   2. o NÓ ANTIGO (nome e idioma digitados, sem `template_id`) continua
 *      ativando e enviando igual — se o catálogo não o localiza, NÃO barra;
 *   3. o ENVIO não mudou: com ou sem `template_id`, o payload é nome + idioma +
 *      valores, que é o que a plataforma aceita.
 */

const h = vi.hoisted(() => ({ banco: null as unknown as BancoEmMemoria, role: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.client }));

import { PATCH as atualizarFluxo } from "@/app/api/v1/flows/[id]/route";
import { entradaDeEnvio } from "@/lib/flows/nodes/message";
import { problemasDosModelos, type ModeloResolvido, type NoParaValidar } from "@/lib/flows/validacao";

const ORG = "org-da-sessao";
const FLUXO = "flow-1";

const CORPO = [{ type: "BODY", text: "Olá {{1}}" }];

function banco(statusDoModelo = "APPROVED", hash = "hash-v1") {
  return criarBanco({
    flows: [{ id: FLUXO, organization_id: ORG, status: "draft", trigger_type: "contact_tag_added", trigger_config: { tag: "VIP" } }],
    flow_nodes: [
      { id: "t", organization_id: ORG, flow_id: FLUXO, type: "TRIGGER", label: "", config: { trigger_type: "contact_tag_added" } },
    ],
    channel_sessions: [],
    meta_templates: [
      {
        id: "tpl-1", organization_id: ORG, waba_id: "1", channel_session_id: null, name: "boas_vindas", language: "pt_BR",
        status: statusDoModelo, category: "UTILITY", rejected_reason: null, quality_score: null, parameter_format: "POSITIONAL",
        contract_hash: hash, components: CORPO, synced_at: "2026-09-23", saved_values: {},
      },
      {
        // Mesmo id na OUTRA organização não pode resolver o nó desta.
        id: "tpl-de-b", organization_id: "org-b", waba_id: "1", channel_session_id: null, name: "boas_vindas", language: "pt_BR",
        status: "APPROVED", category: "UTILITY", rejected_reason: null, quality_score: null, parameter_format: "POSITIONAL",
        contract_hash: "hash-v1", components: CORPO, synced_at: "2026-09-23", saved_values: {},
      },
    ],
  });
}

function comMensagem(config: Record<string, unknown>) {
  h.banco.tabelas.flow_nodes!.push({ id: "m", organization_id: ORG, flow_id: FLUXO, type: "MESSAGE", label: "Boas-vindas", config });
}

async function ativar() {
  const res = await atualizarFluxo(
    new NextRequest(`https://crm.test/api/v1/flows/${FLUXO}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }),
    { params: Promise.resolve({ id: FLUXO }) },
  );
  const corpo = (await res.json()) as { error?: { message: string } };
  return { status: res.status, mensagem: corpo.error?.message ?? "" };
}

const ESCOLHIDO = {
  window_mode: "outside_24h",
  template_id: "tpl-1",
  template_name: "boas_vindas",
  template_language: "pt_BR",
  template_contract_hash: "hash-v1",
  template_values: { "1": "{{contact.name}}" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u-1", idioma: "pt-BR" } });
});

describe("ativar confere o modelo escolhido contra o catálogo", () => {
  it("escolhido, aprovado, contrato igual e espaço preenchido: ativa", async () => {
    h.banco = banco();
    comMensagem(ESCOLHIDO);
    expect((await ativar()).status).toBe(200);
  });

  it("o modelo foi PAUSADO depois da escolha: barra dizendo que não está aprovado", async () => {
    h.banco = banco("PAUSED");
    comMensagem(ESCOLHIDO);
    const r = await ativar();
    expect(r.status).toBe(422);
    expect(r.mensagem).toContain("não está aprovado");
  });

  it("o modelo MUDOU na plataforma desde a escolha (contrato diferente do retrato): barra", async () => {
    h.banco = banco("APPROVED", "hash-v2");
    comMensagem(ESCOLHIDO);
    const r = await ativar();
    expect(r.status).toBe(422);
    expect(r.mensagem).toContain("mudou");
  });

  it("espaço do modelo sem valor: barra nomeando o espaço", async () => {
    h.banco = banco();
    comMensagem({ ...ESCOLHIDO, template_values: { "1": "  " } });
    const r = await ativar();
    expect(r.status).toBe(422);
    expect(r.mensagem).toContain("{{1}}");
  });

  it("template_id que só existe em OUTRA organização é 'não localizado' — nunca resolve pelo vizinho", async () => {
    h.banco = banco();
    comMensagem({ ...ESCOLHIDO, template_id: "tpl-de-b" });
    const r = await ativar();
    expect(r.status).toBe(422);
    expect(r.mensagem).toContain("não foi localizado");
  });
});

describe("o nó ANTIGO, só com nome e idioma digitados", () => {
  const ANTIGO = {
    window_mode: "outside_24h",
    template_name: "boas_vindas",
    template_language: "pt_BR",
    template_values: { "1": "{{contact.name}}" },
  };

  it("localizado pelo par e aprovado: ativa como antes", async () => {
    h.banco = banco();
    comMensagem(ANTIGO);
    expect((await ativar()).status).toBe(200);
  });

  it("NÃO localizado (espelho vazio, sync nunca rodou): não barra — o envio ainda confere na plataforma", async () => {
    h.banco = banco();
    h.banco.tabelas.meta_templates = [];
    comMensagem(ANTIGO);
    expect((await ativar()).status).toBe(200);
  });

  it("localizado mas reprovado: barra, porque o envio falharia do mesmo jeito", async () => {
    h.banco = banco("REJECTED");
    comMensagem(ANTIGO);
    const r = await ativar();
    expect(r.status).toBe(422);
    expect(r.mensagem).toContain("REJECTED");
  });
});

describe("a regra pura", () => {
  const no = (config: Record<string, unknown>): NoParaValidar => ({ id: "m", type: "MESSAGE", label: "", config });
  const atual: ModeloResolvido = {
    name: "boas_vindas", language: "pt_BR", status: "APPROVED", contractHash: "hash-v1",
    espacos: [{ valueKey: "1", onde: "corpo", key: "1" }],
  };

  it("nó FORA do mapa (a rota não conseguiu ler o catálogo) não é julgado", () => {
    expect(problemasDosModelos([no(ESCOLHIDO)], new Map())).toEqual([]);
  });

  it("dentro da janela não tem modelo a conferir", () => {
    expect(problemasDosModelos([no({ window_mode: "inside_24h", body: "oi" })], new Map([["m", null]]))).toEqual([]);
  });

  it("nó escolhido antes do retrato do contrato existir compara com o atual (não acusa mudança)", () => {
    const { template_contract_hash: _semRetrato, ...semHash } = ESCOLHIDO;
    expect(problemasDosModelos([no(semHash)], new Map([["m", atual]]))).toEqual([]);
  });
});

describe("o envio não mudou", () => {
  it("com ou sem template_id, sai nome + idioma + valores resolvidos", () => {
    const contexto = { contact: { name: "Ana" } };
    const antigo = entradaDeEnvio(
      { window_mode: "outside_24h", template_name: "boas_vindas", template_language: "pt_BR", template_values: { "1": "{{contact.name}}" } },
      "conv-1",
      contexto,
    );
    const novo = entradaDeEnvio(ESCOLHIDO as never, "conv-1", contexto);
    expect(novo).toEqual(antigo);
    expect(novo).toEqual({
      ok: true,
      input: {
        conversation_id: "conv-1",
        type: "template",
        template_name: "boas_vindas",
        template_language: "pt_BR",
        template_values: { "1": "Ana" },
      },
    });
  });
});
