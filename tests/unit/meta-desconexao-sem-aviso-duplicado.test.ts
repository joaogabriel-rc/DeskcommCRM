import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CanaisModule from "@/lib/channels";

import { criarBanco, type BancoEmMemoria } from "../helpers/banco-em-memoria";

/**
 * UMA DESCONEXÃO, UM AVISO — e o estado que a Meta gravou fica.
 *
 * O defeito medido na auditoria: depois de um `PARTNER_REMOVED` (aviso aberto,
 * conexão `STOPPED`), a varredura de 5 em 5 minutos via a CONSEQUÊNCIA — o
 * token perdeu o acesso junto com a conta, `FAILED` — e, como o nome do episódio
 * dela era outro, abria um SEGUNDO aviso crítico para o mesmo número, trocava o
 * episódio do provedor pelo dela (perdendo a proteção contra o falso `WORKING`)
 * e gravava `FAILED` por cima do `STOPPED`.
 *
 * Aqui roda o CRON DE VERDADE (`/api/v1/cron/channel-health`) sobre o banco em
 * memória, com o adaptador do canal dublado para responder o que a Graph
 * responderia. O processamento do webhook é o real (`processarEventoDaMeta`).
 *
 * Sabotagem medida: tirar a linha `ehDesconexaoDoProvedor(jaEscalado)` de
 * `sincronizarSaudeDaConexao` deixa vermelho o caso ⭐ (dois avisos).
 */

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoEmMemoria,
  saude: { reachable: true, status: "FAILED", detail: "token sem acesso" } as {
    reachable: boolean;
    status: string | null;
    detail: string | null;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.client }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/channels/meta/ingest", () => ({ ingestMetaInbound: vi.fn(), ingestMetaEcho: vi.fn() }));
vi.mock("@/lib/channels", async (original) => {
  const real = await original<typeof CanaisModule>();
  return {
    ...real,
    getAdapter: () => ({ checkHealth: async () => h.saude }),
  };
});

import { GET as varredura } from "@/app/api/v1/cron/channel-health/route";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { processarEventoDaMeta } from "@/lib/channels/meta/processar-evento";

const ORG = "0403aaaa-0000-4000-8000-000000000001";
const SESSAO = "0403aaaa-5555-4000-8000-000000000001";
const WABA = "980198427658004";

beforeEach(() => {
  h.saude = { reachable: true, status: "FAILED", detail: "token sem acesso" };
  h.banco = criarBanco(
    {
      channel_sessions: [
        {
          id: SESSAO,
          organization_id: ORG,
          provider: "meta_cloud",
          status: "WORKING",
          display_name: "Loja",
          phone_number: "+55 11 9",
          meta_waba_id: WABA,
          meta_phone_number_id: "900111",
          waha_session_name: null,
          zernio_account_id: null,
          datafy_phone_number_id: null,
          archived_at: null,
        },
      ],
      channel_session_health: [],
      agent_inbox_items: [],
    },
    {},
    { agent_inbox_items: { status: "open" } },
  );
});

const sessao = () => h.banco.tabelas.channel_sessions![0]!;
const abertos = () => h.banco.tabelas.agent_inbox_items!.filter((i) => i.status === "open");
const episodio = () => h.banco.tabelas.channel_session_health![0]?.escalated_status ?? null;

async function partnerRemoved() {
  await processarEventoDaMeta(
    h.banco.client as never,
    { kind: "account_update", wabaId: WABA, event: "PARTNER_REMOVED", reason: "PRIMARY_INACTIVITY", initiatedBy: "SYSTEM" },
    { id: SESSAO, organizationId: ORG, wabaId: WABA },
    "2026-09-29T12:00:00.000Z",
  );
}

async function rodarVarredura() {
  const r = await varredura(new NextRequest("https://crm.test/api/v1/cron/channel-health"));
  expect(r.status).toBe(200);
}

describe("PARTNER_REMOVED e depois a varredura", () => {
  it("⭐ a varredura que vê FAILED não abre um segundo aviso — fica o original, com o motivo da Meta", async () => {
    await partnerRemoved();
    expect(abertos()).toHaveLength(1);
    const original = abertos()[0]!;

    await rodarVarredura();
    await rodarVarredura();

    expect(abertos()).toHaveLength(1);
    expect(abertos()[0]!.title).toBe(original.title);
    expect(String(abertos()[0]!.body)).toContain("PRIMARY_INACTIVITY");
    expect(episodio()).toBe("PUSH:DESCONECTADO_NO_PROVEDOR");
  });

  it("o estado STOPPED que a Meta gravou é preservado: a varredura não grava FAILED por cima", async () => {
    await partnerRemoved();
    await rodarVarredura();
    expect(sessao().status).toBe("STOPPED");
  });

  it("o número fora da API (visto pela varredura) também não duplica o aviso", async () => {
    await partnerRemoved();
    h.saude = { reachable: true, status: "STOPPED", detail: "desconectado_no_provedor:numero_DISCONNECTED" };
    await rodarVarredura();
    expect(abertos()).toHaveLength(1);
    expect(episodio()).toBe("PUSH:DESCONECTADO_NO_PROVEDOR");
  });

  it("proteção contra o falso WORKING continua: a credencial respondendo não religa a conexão", async () => {
    await partnerRemoved();
    h.saude = { reachable: true, status: "WORKING", detail: null };
    await rodarVarredura();
    expect(sessao().status).toBe("STOPPED");
    expect(abertos()).toHaveLength(1);
  });

  it("a reconexão (o que `conectarCanalOficial` faz) fecha o incidente; a varredura seguinte volta a valer", async () => {
    await partnerRemoved();
    await rodarVarredura();

    // O que a reconexão grava e chama (lib/channels/meta/conectar.ts).
    sessao().status = "WORKING";
    await sincronizarSaudeDaConexao(
      h.banco.client as never,
      { id: SESSAO, organization_id: ORG, status: "WORKING" },
      { reachable: true, status: "WORKING", detail: null },
      "Loja",
      "empurrao",
    );
    expect(abertos()).toHaveLength(0);
    expect(episodio()).toBeNull();

    // Sem episódio do provedor aberto, uma queda NOVA volta a ser avisada.
    h.saude = { reachable: true, status: "FAILED", detail: "token sem acesso" };
    await rodarVarredura();
    expect(sessao().status).toBe("FAILED");
    expect(abertos()).toHaveLength(1);
  });

  it("CONTROLE: sem PARTNER_REMOVED, a varredura que vê FAILED avisa e grava o estado, como sempre", async () => {
    await rodarVarredura();
    expect(sessao().status).toBe("FAILED");
    expect(abertos()).toHaveLength(1);
  });
});
