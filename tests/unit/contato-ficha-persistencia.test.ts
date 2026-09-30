import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

import { getContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { contactPatchSchema } from "@/lib/schemas/contacts";
import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * O QUE A FICHA SALVA PERSISTE — e só na organização de quem salvou.
 *
 * O diálogo manda a lista inteira de tags e o mapa inteiro de campos (o PATCH
 * substitui). Aqui o lado do servidor, com o schema e o handler de verdade, num
 * banco que aplica o filtro de organização: gravar, "recarregar" (ler de novo) e
 * conferir que a outra organização não foi tocada nem é alcançável.
 */

const ORG_A = "0402aaaa-0000-4000-8000-000000000001";
const ORG_B = "0402bbbb-0000-4000-8000-000000000002";
const CONTATO_A = "0402aaaa-cccc-4000-8000-000000000001";
const CONTATO_B = "0402bbbb-cccc-4000-8000-000000000001";

let banco: BancoEmMemoria;

function contato(id: string, org: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: org,
    name: "Contato",
    display_name: null,
    email: null,
    phone_number: null,
    is_anonymized: false,
    is_blocked: false,
    is_merged_into: null,
    consent: {},
    tags: ["vip"],
    custom_fields: { cidade: "Recife" },
    ...extra,
  };
}

beforeEach(() => {
  banco = criarBanco(
    { contacts: [contato(CONTATO_A, ORG_A), contato(CONTATO_B, ORG_B)] },
    { emit_event: () => null },
  );
});

const ctx = (org: string) => ({ organization_id: org, actor: { type: "user" as const, id: "u-1" }, requestId: "req" });

async function salvar(org: string, id: string, corpo: Record<string, unknown>) {
  const input = contactPatchSchema.parse(corpo);
  return patchContactHandler(banco.client as never, ctx(org) as never, id, input);
}

describe("persistência da ficha", () => {
  it("várias tags, campo editado e campo limpo — e a leitura seguinte devolve o mesmo", async () => {
    await salvar(ORG_A, CONTATO_A, {
      tags: ["vip", "DECORE_ALUNOS", "cci_tem_duvida"],
      custom_fields: { onboarding: "feito" },
    });
    const relido = await getContactHandler(banco.client as never, ctx(ORG_A) as never, { contactId: CONTATO_A } as never);
    expect((relido as { tags: string[] }).tags).toEqual(["vip", "decore_alunos", "cci_tem_duvida"]);
    // `cidade` saiu do mapa: foi LIMPA, não gravada vazia.
    expect((relido as { custom_fields: Record<string, unknown> }).custom_fields).toEqual({ onboarding: "feito" });
  });

  it("remover uma tag grava a lista sem ela", async () => {
    await salvar(ORG_A, CONTATO_A, { tags: [] });
    expect(banco.tabelas.contacts!.find((c) => c.id === CONTATO_A)!.tags).toEqual([]);
  });

  it("isolamento: salvar na A não toca a B, e a A não alcança o contato da B", async () => {
    await salvar(ORG_A, CONTATO_A, { tags: ["novo"], custom_fields: {} });
    const b = banco.tabelas.contacts!.find((c) => c.id === CONTATO_B)!;
    expect(b.tags).toEqual(["vip"]);
    expect(b.custom_fields).toEqual({ cidade: "Recife" });

    await expect(salvar(ORG_A, CONTATO_B, { tags: ["invasao"] })).rejects.toMatchObject({ status: 404 });
    expect(banco.tabelas.contacts!.find((c) => c.id === CONTATO_B)!.tags).toEqual(["vip"]);
  });
});
