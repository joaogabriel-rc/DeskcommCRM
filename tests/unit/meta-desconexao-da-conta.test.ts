import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/meta/ingest", () => ({ ingestMetaInbound: vi.fn(), ingestMetaEcho: vi.fn() }));

import { numeroForaDaApi } from "@/lib/channels/adapters/meta-cloud";
import { avisoDaConexao, episodioDoEmpurraoAberto, PREFIXO_DESCONECTADO_NO_PROVEDOR } from "@/lib/channels/health";
import { processarEventoDaMeta } from "@/lib/channels/meta/processar-evento";
import { parseMetaWebhook, type AccountUpdateEvent } from "@/lib/channels/meta/webhook";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * DESCONECTAR PELO CELULAR TIRA O "CONECTADO" DA TELA.
 *
 * O relato: desconectar o número da API pelo app WhatsApp Business (ou pelo
 * Gerenciador da Meta) deixava a conexão "Conectado" no CRM, e a única saída era
 * excluí-la pela lixeira para conectar outro número.
 *
 * A causa, em duas metades:
 *   - o webhook ignorava `account_update`, que é por onde a Meta AVISA
 *     (`PARTNER_REMOVED`, com `disconnection_info` na coexistência);
 *   - o vigia de saúde perguntava `GET /{phone_number_id}` e só via erro: o número
 *     desconectado continua existindo na conta, então a resposta era 200 e o
 *     estado seguia `WORKING`.
 *
 * O conserto não apaga nem arquiva a conexão — marca `STOPPED`, avisa na Central,
 * e a reconexão reaproveita a mesma linha (histórico intacto).
 *
 * Sabotagem medida: tirar o ramo `account_update` de `processarEventoDaMeta` deixa
 * vermelho o caso ⭐; tirar a checagem de `status` de `numeroForaDaApi`, o caso do
 * número `DISCONNECTED`.
 */

const ORG_A = "0401aaaa-0000-4000-8000-000000000001";
const ORG_B = "0401bbbb-0000-4000-8000-000000000002";
const SESSAO_A = "0401aaaa-5555-4000-8000-000000000001";
const SESSAO_B = "0401bbbb-5555-4000-8000-000000000001";
const WABA = "980198427658004";
const AGORA = "2026-09-29T12:00:00.000Z";

/** O exemplo da referência oficial do `account_update`, byte a byte no que importa. */
const PARTNER_REMOVED = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "2949482758682047",
      time: 1748477359,
      changes: [
        {
          value: {
            event: "PARTNER_REMOVED",
            waba_info: { waba_id: WABA, owner_business_id: "2329417887457253" },
            disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" },
          },
          field: "account_update",
        },
      ],
    },
  ],
};

function banco() {
  return criarBanco({
    channel_sessions: [
      { id: SESSAO_A, organization_id: ORG_A, provider: "meta_cloud", status: "WORKING", display_name: "Loja A", phone_number: "+55 11 9", meta_waba_id: WABA, archived_at: null },
      { id: SESSAO_B, organization_id: ORG_B, provider: "meta_cloud", status: "WORKING", display_name: "Loja B", phone_number: "+55 11 8", meta_waba_id: WABA, archived_at: null },
    ],
    channel_session_health: [],
    agent_inbox_items: [],
  }, {}, { agent_inbox_items: { status: "open" } });
}

const sessaoA = { id: SESSAO_A, organizationId: ORG_A, wabaId: WABA };

function evento(parcial: Partial<AccountUpdateEvent> = {}): AccountUpdateEvent {
  return { kind: "account_update", wabaId: WABA, event: "PARTNER_REMOVED", reason: null, initiatedBy: null, ...parcial };
}

describe("o parse do `account_update`", () => {
  it("lê o evento, a conta (`waba_info.waba_id`, não o `entry.id`) e o motivo", () => {
    const [e] = parseMetaWebhook(PARTNER_REMOVED as never);
    expect(e).toEqual({
      kind: "account_update",
      wabaId: WABA,
      event: "PARTNER_REMOVED",
      reason: "PRIMARY_INACTIVITY",
      initiatedBy: "SYSTEM",
    });
  });

  it("sem `waba_info`, a conta é o `entry.id`; sem `event`, nada entra", () => {
    const semInfo = structuredClone(PARTNER_REMOVED);
    delete (semInfo.entry[0]!.changes[0]!.value as Record<string, unknown>).waba_info;
    expect(parseMetaWebhook(semInfo as never)[0]).toMatchObject({ wabaId: "2949482758682047" });

    const semEvento = structuredClone(PARTNER_REMOVED);
    delete (semEvento.entry[0]!.changes[0]!.value as Record<string, unknown>).event;
    expect(parseMetaWebhook(semEvento as never)).toEqual([]);
  });
});

describe("processar a desconexão da conta", () => {
  it("⭐ PARTNER_REMOVED: a conexão vira STOPPED e a Central ganha um aviso crítico que diz o motivo", async () => {
    const db = banco();
    const desfecho = await processarEventoDaMeta(db.client as never, evento({ reason: "PRIMARY_INACTIVITY", initiatedBy: "SYSTEM" }), sessaoA, AGORA);

    expect(desfecho).toBe("conta_desconectada");
    const a = db.tabelas.channel_sessions!.find((s) => s.id === SESSAO_A)!;
    expect(a.status).toBe("STOPPED");
    expect(a.archived_at).toBeNull(); // não arquiva nem apaga
    const avisos = db.tabelas.agent_inbox_items!;
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ organization_id: ORG_A, severity: "critical", ref_id: SESSAO_A });
    expect(String(avisos[0]!.title)).toContain("desconectado da API");
    expect(String(avisos[0]!.body)).toContain("PRIMARY_INACTIVITY");
    // O episódio é do PROVEDOR: a varredura não o fecha nem desfaz o STOPPED.
    expect(await episodioDoEmpurraoAberto(db.client as never, SESSAO_A, ORG_A)).toBe(true);
  });

  it("isolamento: a sessão de OUTRA organização na mesma conta não é tocada por este processamento", async () => {
    const db = banco();
    await processarEventoDaMeta(db.client as never, evento(), sessaoA, AGORA);
    expect(db.tabelas.channel_sessions!.find((s) => s.id === SESSAO_B)!.status).toBe("WORKING");
    expect(db.tabelas.agent_inbox_items!.every((i) => i.organization_id === ORG_A)).toBe(true);
  });

  it("a reentrega do mesmo evento não abre um segundo aviso", async () => {
    const db = banco();
    await processarEventoDaMeta(db.client as never, evento(), sessaoA, AGORA);
    await processarEventoDaMeta(db.client as never, evento(), sessaoA, AGORA);
    expect(db.tabelas.agent_inbox_items!).toHaveLength(1);
  });

  it("evento de OUTRA conta não muda esta sessão", async () => {
    const db = banco();
    expect(await processarEventoDaMeta(db.client as never, evento({ wabaId: "111" }), sessaoA, AGORA)).toBe("waba_divergente");
    expect(db.tabelas.channel_sessions!.find((s) => s.id === SESSAO_A)!.status).toBe("WORKING");
  });

  it("evento de conta que não é desconexão (ex.: preço) é ignorado", async () => {
    const db = banco();
    expect(await processarEventoDaMeta(db.client as never, evento({ event: "VOLUME_BASED_PRICING_TIER_UPDATE" }), sessaoA, AGORA)).toBeNull();
    expect(db.tabelas.channel_sessions!.find((s) => s.id === SESSAO_A)!.status).toBe("WORKING");
  });

  it("ACCOUNT_RECONNECTED fecha o aviso; o estado volta a WORKING pela varredura, que pergunta ao número", async () => {
    const db = banco();
    await processarEventoDaMeta(db.client as never, evento(), sessaoA, AGORA);
    expect(await processarEventoDaMeta(db.client as never, evento({ event: "ACCOUNT_RECONNECTED" }), sessaoA, AGORA)).toBe(
      "conta_reconectada",
    );
    expect(db.tabelas.agent_inbox_items![0]!.status).toBe("resolved");
    expect(await episodioDoEmpurraoAberto(db.client as never, SESSAO_A, ORG_A)).toBe(false);
    expect(db.tabelas.channel_sessions!.find((s) => s.id === SESSAO_A)!.status).toBe("STOPPED");
  });
});

describe("o vigia de saúde lê o estado do NÚMERO, não só se a chamada respondeu", () => {
  it("CONNECTED na Cloud API: está na API", () => {
    expect(numeroForaDaApi({ status: "CONNECTED", platform_type: "CLOUD_API" })).toBeNull();
    expect(numeroForaDaApi({})).toBeNull(); // campo ausente não é prova de nada
  });

  it("DISCONNECTED/DELETED/BANNED/MIGRATED: fora da API", () => {
    expect(numeroForaDaApi({ status: "DISCONNECTED", platform_type: "CLOUD_API" })).toBe("numero_DISCONNECTED");
    expect(numeroForaDaApi({ status: "deleted" })).toBe("numero_DELETED");
    expect(numeroForaDaApi({ status: "BANNED" })).toBe("numero_BANNED");
  });

  it("saiu da Cloud API (`platform_type` diferente): fora da API", () => {
    expect(numeroForaDaApi({ status: "CONNECTED", platform_type: "NOT_APPLICABLE" })).toBe("plataforma_NOT_APPLICABLE");
  });

  it("qualidade baixa (FLAGGED) ou limite de taxa NÃO derrubam a conexão", () => {
    expect(numeroForaDaApi({ status: "FLAGGED", platform_type: "CLOUD_API" })).toBeNull();
    expect(numeroForaDaApi({ status: "RATE_LIMITED", platform_type: "CLOUD_API" })).toBeNull();
  });

  it("o aviso da desconexão pelo provedor diz o que fazer (reconectar), não \"escaneie o QR\"", () => {
    const aviso = avisoDaConexao(
      { reachable: true, status: "STOPPED", detail: `${PREFIXO_DESCONECTADO_NO_PROVEDOR}numero_DISCONNECTED` },
      "Loja",
    );
    expect(aviso?.title).toBe('WhatsApp "Loja" foi desconectado da API');
    expect(aviso?.body).toContain("conecte o número de novo");
  });

  it("a varredura não põe WORKING por cima de um episódio aberto pelo provedor", () => {
    const cron = readFileSync(join(process.cwd(), "app/api/v1/cron/channel-health/route.ts"), "utf8");
    const i = cron.indexOf("episodioDoEmpurraoAberto(");
    const j = cron.indexOf('.update({ status: saude.status, last_status_change_at: agora })');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(cron).toMatch(/!bloqueadaPeloEmpurrao/);
  });
});
