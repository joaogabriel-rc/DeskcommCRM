import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { resolverModelo } from "@/lib/channels/catalogo-de-modelos";
import { criarBanco } from "../helpers/banco-em-memoria";

/**
 * A DEFINIÇÃO DO MODELO PARA UMA CONEXÃO — pelo resolvedor central.
 *
 * Os sete cenários de `modelo-do-canal-oficial-acha-a-definicao.test.ts` (da
 * upstream, escritos para `linhaDoEspelho`), portados para `resolverModelo`,
 * que é o caminho ÚNICO do pré-voo, do envio, de Fluxos, de Disparos e da
 * criação de modelo. Mais o caso da ordem de preferência que aquele arquivo
 * não cobria: com a linha da conexão E a da conta, vale a da conexão.
 *
 * O sync do canal oficial grava `meta_templates` por `waba_id`, com
 * `channel_session_id` NULO; os parceiros gravam a conexão. As contas aqui são
 * numéricas porque o recorte por conta só aceita id numérico (é texto
 * interpolado num filtro — ver `escopoDaConexao`).
 */

const ORG = "org-1";
const OFICIAL = "sessao-oficial";
const PARCEIRO = "sessao-parceiro";
const WABA = "111";

type Linha = Record<string, unknown>;

const sessoes: Linha[] = [
  { organization_id: ORG, id: OFICIAL, provider: "meta_cloud", meta_waba_id: WABA, archived_at: null },
  { organization_id: ORG, id: PARCEIRO, provider: "datafy", meta_waba_id: null, archived_at: null },
];

const modelo = (over: Linha): Linha => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  organization_id: ORG,
  name: "retomada",
  language: "pt_BR",
  channel_session_id: null,
  waba_id: WABA,
  status: "APPROVED",
  category: "UTILITY",
  parameter_format: "POSITIONAL",
  contract_hash: "h",
  components: [{ type: "BODY", text: "Oi" }],
  synced_at: "2026-09-20",
  ...over,
});

const banco = (tabelas: Record<string, Linha[]>) => criarBanco(tabelas).client as unknown as SupabaseClient;

const buscar = (db: SupabaseClient, channelSessionId: string | null) =>
  resolverModelo(db, ORG, {
    name: "retomada",
    language: "pt_BR",
    channelSessionId,
    // A regra do pré-voo e do envio: sem conexão, o par em duas contas não escolhe.
    ambiguoNaoResolve: true,
  });

describe("a definição do modelo para uma conexão (resolvedor central)", () => {
  it("canal oficial: acha a linha do sync, gravada sem conexão, na WABA da sessão", async () => {
    const r = await buscar(banco({ channel_sessions: sessoes, meta_templates: [modelo({})] }), OFICIAL);
    expect(r?.status).toBe("APPROVED");
  });

  it("oficial + parceiro com o mesmo nome: cada conexão acha a SUA linha, sem ambiguidade", async () => {
    const db = banco({
      channel_sessions: sessoes,
      meta_templates: [modelo({}), modelo({ channel_session_id: PARCEIRO, waba_id: "waba-parceiro", status: "PENDING" })],
    });
    expect((await buscar(db, OFICIAL))?.channelSessionId).toBeNull();
    expect((await buscar(db, PARCEIRO))?.status).toBe("PENDING");
  });

  it("parceiro SEM linha própria nunca herda a definição do canal oficial", async () => {
    const r = await buscar(banco({ channel_sessions: sessoes, meta_templates: [modelo({})] }), PARCEIRO);
    expect(r).toBeNull();
  });

  it("linha órfã sem conexão de outra conta (parceiro apagado) não serve ao canal oficial", async () => {
    const r = await buscar(
      banco({ channel_sessions: sessoes, meta_templates: [modelo({ waba_id: "999" })] }),
      OFICIAL,
    );
    expect(r).toBeNull();
  });

  it("duas contas oficiais com o mesmo modelo: cada sessão acha a da SUA conta, sem ambiguidade", async () => {
    const db = banco({
      channel_sessions: [
        ...sessoes,
        { organization_id: ORG, id: "sessao-2", provider: "meta_cloud", meta_waba_id: "222", archived_at: null },
      ],
      meta_templates: [modelo({}), modelo({ waba_id: "222", status: "PAUSED" })],
    });
    expect((await buscar(db, OFICIAL))?.status).toBe("APPROVED");
    expect((await buscar(db, "sessao-2"))?.status).toBe("PAUSED");
  });

  it("linha de OUTRA organização nunca serve — nem a da conexão, nem a sem conexão", async () => {
    const db = banco({
      channel_sessions: sessoes,
      meta_templates: [modelo({ organization_id: "org-2", channel_session_id: OFICIAL }), modelo({ organization_id: "org-2" })],
    });
    expect(await buscar(db, OFICIAL)).toBeNull();
    expect(await buscar(db, null)).toBeNull();
  });

  it("sem conexão (base anterior à 0144): busca como sempre buscou", async () => {
    const r = await buscar(banco({ meta_templates: [modelo({})] }), null);
    expect(r?.status).toBe("APPROVED");
  });

  it("com a linha da conexão E a da conta, vale a da CONEXÃO — mesmo sendo a mais antiga", async () => {
    const db = banco({
      channel_sessions: sessoes,
      meta_templates: [
        modelo({ status: "PAUSED", synced_at: "2026-09-23" }),
        modelo({ channel_session_id: OFICIAL, waba_id: "777", status: "APPROVED", synced_at: "2026-09-01" }),
      ],
    });
    const r = await buscar(db, OFICIAL);
    expect(r?.channelSessionId).toBe(OFICIAL);
    expect(r?.status).toBe("APPROVED");
  });
});
