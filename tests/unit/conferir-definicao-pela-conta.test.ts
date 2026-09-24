import { describe, expect, it } from "vitest";

import { conferirDefinicao } from "@/lib/channels/conferir-definicao";
import { hashContract } from "@/lib/channels/meta/contract-hash";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * O PRÉ-VOO DO ENVIO DE MODELO RESOLVE A DEFINIÇÃO PELA CONTA DO NÚMERO.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * O sync oficial grava o modelo por CONTA (`waba_id`), com `channel_session_id`
 * vazio. O pré-voo filtrava `channel_session_id = número da conversa` — e como
 * o envio sempre sabe o número, a linha oficial NUNCA era achada: o pré-voo
 * tratava todo modelo oficial como "não espelhado" e deixava passar. Modelo
 * pausado, reprovado ou com espaço faltando só aparecia na recusa da Meta.
 *
 * Agora a definição sai do catálogo central (`resolverModelo`): a linha da
 * conexão, ou a linha SEM conexão da mesma WABA. Os seis casos pedidos.
 */

const ORG_A = "org-a";
const ORG_B = "org-b";
const SESSAO_A = "sessao-a"; // WABA 111
const SESSAO_A2 = "sessao-a2"; // WABA 222, mesma organização
const SESSAO_WAHA = "sessao-waha";

const CORPO = [{ type: "BODY", text: "Olá {{1}}" }];

function linha(o: Record<string, unknown>) {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    organization_id: ORG_A,
    waba_id: "111",
    channel_session_id: null,
    name: "boas",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "POSITIONAL",
    contract_hash: hashContract(CORPO),
    components: CORPO,
    synced_at: "2026-09-24",
    ...o,
  };
}

function banco(modelos: Array<Record<string, unknown>>) {
  return criarBanco({
    channel_sessions: [
      { id: SESSAO_A, organization_id: ORG_A, provider: "meta_cloud", meta_waba_id: "111", archived_at: null },
      { id: SESSAO_A2, organization_id: ORG_A, provider: "meta_cloud", meta_waba_id: "222", archived_at: null },
      { id: SESSAO_WAHA, organization_id: ORG_A, provider: "waha", meta_waba_id: null, archived_at: null },
    ],
    meta_templates: modelos,
  }).client;
}

const conferir = (db: never, channelSessionId: string | null, values: Record<string, string> = { "1": "Ana" }) =>
  conferirDefinicao(db, { organizationId: ORG_A, channelSessionId, name: "boas", language: "pt_BR", values });

describe("pré-voo pela conta do número", () => {
  it("1 · modelo oficial com channel_session_id VAZIO é achado pela WABA do número — e conferido", async () => {
    // O defeito: antes, esta linha nunca era achada e o pausado passava.
    await expect(conferir(banco([linha({ status: "PAUSED" })]), SESSAO_A)).rejects.toThrow(/template_not_approved.*PAUSED/s);
  });

  it("2 · modelo certo, da mesma WABA, aprovado e com os valores: passa", async () => {
    await expect(conferir(banco([linha({})]), SESSAO_A)).resolves.toBeUndefined();
    // E a conferência de valores volta a valer para o oficial.
    await expect(conferir(banco([linha({})]), SESSAO_A, {})).rejects.toThrow(/template_missing_values/);
  });

  it("3 · modelo de OUTRA WABA da mesma organização: recusa — o número desta conversa não o entrega", async () => {
    await expect(conferir(banco([linha({ waba_id: "222" })]), SESSAO_A)).rejects.toThrow(/template_other_account/);
  });

  it("4 · modelo de OUTRA organização: nunca é usado, nem para aprovar nem para reprovar", async () => {
    // Só a linha da B existe — reprovada. A não é afetada por ela (é "não
    // espelhado" para A, e o provedor decide)...
    await expect(conferir(banco([linha({ organization_id: ORG_B, status: "REJECTED" })]), SESSAO_A)).resolves.toBeUndefined();
    // ...e a aprovação da B não salva a linha reprovada da A.
    await expect(
      conferir(banco([linha({ status: "REJECTED" }), linha({ organization_id: ORG_B })]), SESSAO_A),
    ).rejects.toThrow(/template_not_approved.*REJECTED/s);
  });

  it("5 · com número explícito, vale o catálogo DESSE número", async () => {
    // Pelo número A2 (WABA 222), o modelo da WABA 222 é que conta — o da 111 não.
    const db = banco([linha({ waba_id: "111" }), linha({ waba_id: "222", status: "PAUSED" })]);
    await expect(conferir(db, SESSAO_A2)).rejects.toThrow(/template_not_approved.*PAUSED/s);
    await expect(conferir(db, SESSAO_A)).resolves.toBeUndefined();
    // Linha gravada COM a conexão (canal parceiro/Graph) continua casando por ela.
    await expect(
      conferir(banco([linha({ waba_id: "outro", channel_session_id: SESSAO_A, status: "REJECTED" })]), SESSAO_A),
    ).rejects.toThrow(/template_not_approved/);
  });

  it("6 · sem número (base anterior à 0144): a regra de sempre — resolve se é único; ambíguo, passa", async () => {
    await expect(conferir(banco([linha({ status: "PAUSED" })]), null)).rejects.toThrow(/template_not_approved/);
    // O mesmo par em duas contas: sem número não há como saber qual — não escolhe.
    await expect(
      conferir(banco([linha({ waba_id: "111", status: "PAUSED" }), linha({ waba_id: "222" })]), null),
    ).resolves.toBeUndefined();
  });

  it("controles: número sem catálogo (WAHA) e modelo não espelhado em conta nenhuma continuam passando", async () => {
    await expect(conferir(banco([linha({ status: "PAUSED" })]), SESSAO_WAHA)).resolves.toBeUndefined();
    await expect(conferir(banco([]), SESSAO_A)).resolves.toBeUndefined();
  });
});
