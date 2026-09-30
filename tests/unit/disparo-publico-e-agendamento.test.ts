import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * DISPAROS — o público com campos do sistema, o agendamento no fuso da
 * organização e a ida ao Construtor de Fluxos sem duplicar o fluxo.
 *
 * Rotas de verdade sobre o banco dublê que aplica filtro. O que o BANCO garante
 * (FK, trigger) segue em tests/invariants/disparo-com-fluxo.test.ts.
 *
 * Sabotagens medidas:
 *   - tirar a guarda `horarioJaPassou` da rota → o caso ⭐ do horário passado fica verde para 200;
 *   - `colunaDoCampo` ignorar a `origem` → o caso ⭐ do campo do sistema conta 0.
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  role: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.client }));

import { GET as previa } from "@/app/api/v1/broadcasts/previa/route";
import { POST as criarDisparo } from "@/app/api/v1/broadcasts/route";
import { PATCH as mudarDisparo } from "@/app/api/v1/broadcasts/[id]/route";
import {
  horarioJaPassou,
  instanteDoAgendamento,
  paredeDoAgendamento,
  problemaDoAgendamento,
} from "@/lib/disparos/agendamento";
import { expressaoDoSegmento, filtrosDoSegmento } from "@/lib/disparos/segmento";
import { juntarEtiquetas } from "@/hooks/catalogo/useOpcoesDeEtiqueta";
import { segmentoSchema } from "@/lib/schemas/disparos";

const ORG = "org-a";
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://crm.test${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const corpo = async (r: Response) => (await r.json()) as { data: Record<string, unknown>; error?: { message: string } };

beforeEach(() => {
  vi.clearAllMocks();
  h.banco = criarBanco(
    {
      broadcasts: [],
      flows: [],
      flow_nodes: [],
      flow_edges: [],
      contacts: [
        { id: "c1", organization_id: ORG, name: "Ana Souza", email: "ana@x.com", is_blocked: false, is_anonymized: false, is_merged_into: null, phone_number: "+551", tags: ["vip"], custom_fields: {}, created_at: "1" },
        { id: "c2", organization_id: ORG, name: "Bruno", email: null, is_blocked: false, is_anonymized: false, is_merged_into: null, phone_number: "+552", tags: ["vip"], custom_fields: {}, created_at: "2" },
        { id: "c3", organization_id: "org-b", name: "Ana Souza", email: "ana@b.com", is_blocked: false, is_anonymized: false, is_merged_into: null, phone_number: "+553", tags: ["vip"], custom_fields: {}, created_at: "3" },
      ],
      channel_sessions: [],
      meta_templates: [],
    },
    {},
    {
      broadcasts: { status: "draft", segment: {}, message: {}, total_recipients: 0, sent_count: 0, failed_count: 0, skipped_count: 0 },
      flows: { status: "draft", version: 1, trigger_config: {} },
    },
  );
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u-1", idioma: "pt-BR" } });
});

describe("o horário, no fuso da organização", () => {
  it("14:30 em São Paulo é 17:30 UTC — e volta para os mesmos campos", () => {
    const instante = instanteDoAgendamento("2026-10-01", "14:30", "America/Sao_Paulo");
    expect(instante?.toISOString()).toBe("2026-10-01T17:30:00.000Z");
    expect(paredeDoAgendamento(instante!.toISOString(), "America/Sao_Paulo")).toEqual({ data: "2026-10-01", hora: "14:30" });
  });

  it("o mesmo 14:30 em Lisboa é outro instante — a hora vale no fuso escolhido, não no do navegador", () => {
    expect(instanteDoAgendamento("2026-10-01", "14:30", "Europe/Lisbon")?.toISOString()).toBe("2026-10-01T13:30:00.000Z");
  });

  it("data que não existe (31/02) ou hora inválida não vira instante corrigido em silêncio", () => {
    expect(instanteDoAgendamento("2026-02-31", "10:00", "America/Sao_Paulo")).toBeNull();
    expect(instanteDoAgendamento("2026-10-01", "25:00", "America/Sao_Paulo")).toBeNull();
  });

  it("valida: vazio = enviar agora; metade preenchida pede o resto; passado é recusado", () => {
    const agora = new Date("2026-09-29T15:00:00Z");
    expect(problemaDoAgendamento("", "", "America/Sao_Paulo", agora)).toBeNull();
    expect(problemaDoAgendamento("2026-10-01", "", "America/Sao_Paulo", agora)).toMatch(/data e a hora/);
    expect(problemaDoAgendamento("2026-09-29", "08:00", "America/Sao_Paulo", agora)).toMatch(/já passou/);
    expect(problemaDoAgendamento("2026-09-29", "18:00", "America/Sao_Paulo", agora)).toBeNull();
    // A folga de um minuto: "agora mesmo" não é passado.
    expect(horarioJaPassou(new Date(agora.getTime() - 30_000), agora)).toBe(false);
  });

  it("⭐ a rota recusa agendar um rascunho cujo horário já passou", async () => {
    const criado = await criarDisparo(
      req("/api/v1/broadcasts", "POST", { name: "Ontem", segment: { tags_all: ["vip"] }, message: { window_mode: "inside_24h", body: "Oi" } }),
    );
    const { data } = await corpo(criado);
    const id = data.id as string;
    await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { scheduled_at: "2020-01-01T10:00:00Z" }), params(id));

    const r = await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { acao: "agendar" }), params(id));
    expect(r.status).toBe(422);
    expect((await corpo(r)).error?.message).toMatch(/já passou/);
    expect(h.banco.tabelas.broadcasts!.find((b) => b.id === id)!.status).toBe("draft");
  });
});

describe("o público: campos do SISTEMA ao lado dos personalizados", () => {
  it("⭐ `name contém \"ana\"` (sistema) conta só a Ana desta organização", async () => {
    const segmento = { fields: [{ key: "name", op: "contains", value: "ana", origem: "sistema" }] };
    const r = await previa(req(`/api/v1/broadcasts/previa?segmento=${encodeURIComponent(JSON.stringify(segmento))}`, "GET"));
    const { data } = await corpo(r);
    expect(data.total).toBe(1);
    expect(data.expressao).toEqual(['TODAS: Nome contém "ana"']);
  });

  it("campo do sistema vira COLUNA; sem `origem` continua `custom_fields` (segmento gravado antes)", () => {
    const sistema = filtrosDoSegmento(ORG, segmentoSchema.parse({ fields: [{ key: "email", op: "set", origem: "sistema" }] }));
    expect(sistema.at(-1)).toEqual({ metodo: "not", coluna: "email", operador: "is", valor: null });
    const antigo = filtrosDoSegmento(ORG, segmentoSchema.parse({ fields: [{ key: "email", op: "set" }] }));
    expect(antigo.at(-1)).toEqual({ metodo: "not", coluna: "custom_fields->>email", operador: "is", valor: null });
  });

  it("só a lista fechada vira coluna: `origem: sistema` com outra chave é recusado pelo schema", () => {
    expect(segmentoSchema.safeParse({ fields: [{ key: "is_blocked", op: "eq", value: "true", origem: "sistema" }] }).success).toBe(false);
    expect(segmentoSchema.safeParse({ fields: [{ key: "phone_number", op: "set", origem: "sistema" }] }).success).toBe(true);
  });

  it("a frase da prévia usa o rótulo do sistema e mantém a chave do personalizado", () => {
    expect(
      expressaoDoSegmento({ fields_none: [{ key: "phone_number", op: "unset", value: "", origem: "sistema" }, { key: "plano", op: "eq", value: "ouro" }] }),
    ).toEqual(['NENHUMA: Telefone vazio OU plano = "ouro"']);
  });
});

describe("as etiquetas que o seletor oferece", () => {
  it("⭐ registro VAZIO + etiquetas aplicadas: a lista não vem vazia (era o menu que abria sem nada)", () => {
    expect(juntarEtiquetas([], ["decore_alunos", "cci_tem_duvida"]).opcoes).toEqual(["cci_tem_duvida", "decore_alunos"]);
  });

  it("une as duas fontes sem repetir, e a grafia do registro vence", () => {
    const { opcoes, doRegistro } = juntarEtiquetas(["VIP", "Clientes"], ["vip", "lead_frio"]);
    expect(opcoes).toEqual(["Clientes", "lead_frio", "VIP"]);
    expect([...doRegistro].sort()).toEqual(["clientes", "vip"]);
  });
});

describe("Ir para o Construtor de Fluxos não duplica o fluxo", () => {
  it("guiado → fluxo cria UM fluxo; salvar de novo em modo fluxo reaproveita o mesmo", async () => {
    const criado = await criarDisparo(req("/api/v1/broadcasts", "POST", { name: "Promo", segment: { tags_all: ["vip"] } }));
    const id = (await corpo(criado)).data.id as string;

    const ida = await corpo(await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { modo: "fluxo" }), params(id)));
    const fluxo = (ida.data.fluxo as { id: string }).id;
    const volta = await corpo(
      await mudarDisparo(req(`/api/v1/broadcasts/${id}`, "PATCH", { modo: "fluxo", name: "Promo 2", segment: { tags_all: ["vip"] } }), params(id)),
    );
    expect((volta.data.fluxo as { id: string }).id).toBe(fluxo);
    expect(h.banco.tabelas.flows!.filter((f) => f.broadcast_id === id)).toHaveLength(1);
    // O público salvo na ida continua lá.
    expect(h.banco.tabelas.broadcasts!.find((b) => b.id === id)!.segment).toMatchObject({ tags_all: ["vip"] });
  });
});
