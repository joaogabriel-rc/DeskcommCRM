/**
 * O cron `meta-ecos-em-espera` lê a quarentena INTEIRA para achar as janelas com
 * trabalho (0436, B4 da auditoria).
 *
 * O PostgREST corta toda resposta em `max_rows` (1000 em supabase/config.toml).
 * A versão anterior lia `limit(2000)` sem ordem: numa quarentena com mais de 1000
 * linhas, as janelas que não coubessem no recorte nunca eram vistas. Aqui:
 *   - a leitura pagina por `id` (keyset) até uma página VAZIA, então nenhum corte
 *     do servidor — maior OU menor que a página — é lido como "acabou";
 *   - as janelas saem em ordem determinística;
 *   - com mais de `LIMITE_DE_JANELAS`, o rodízio pelo relógio do cron cobre todas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { LIMITE_DE_JANELAS, janelasComEspera } from "@/app/api/v1/cron/meta-ecos-em-espera/route";

type Linha = Record<string, unknown>;

/** Só a quarentena, com o corte de resposta do PostgREST (`maxRows`). */
function quarentena(linhas: Linha[], maxRows: number) {
  const consultas: number[] = [];
  const from = () => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: string | null = null;
    let limite = Infinity;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      like: (c: string, p: string) => {
        const prefixo = p.replace(/%$/, "");
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string).startsWith(prefixo));
        return q;
      },
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      order: (c: string) => ((ordem = c), q),
      limit: (n: number) => ((limite = n), q),
      then: (ok: (r: unknown) => void) => {
        const r = linhas.filter((l) => filtros.every((f) => f(l)));
        if (ordem) r.sort((a, b) => (String(a[ordem!]) < String(b[ordem!]) ? -1 : 1));
        const pagina = r.slice(0, Math.min(limite, maxRows));
        consultas.push(pagina.length);
        return Promise.resolve({ data: pagina, error: null }).then(ok);
      },
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, consultas };
}

const ORG = "org-a";
const SESSAO = "s-a";
const onboarding = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString();

/** `n` ecos aguardando na janela `j`, com ids a partir de `base` (a ordem de id é a de inserção). */
function ecos(n: number, j: number, base: number, estado = "aguardando", motivo: string | null = null): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `eco-${String(base + i).padStart(6, "0")}`,
    organization_id: ORG,
    channel_session_id: SESSAO,
    onboarding_em: onboarding(j),
    estado,
    motivo,
  }));
}

const AGORA = new Date("2026-09-27T12:00:00.000Z");

describe("janelasComEspera — leitura completa, determinística e sem janela esquecida", () => {
  it("1.500 ecos numa janela e 1 numa segunda, DEPOIS do milésimo: as duas janelas aparecem", async () => {
    const { admin } = quarentena([...ecos(1500, 1, 0), ...ecos(1, 2, 1500)], 1000);
    const janelas = await janelasComEspera(admin as never, AGORA);
    expect(janelas.map((j) => j.onboardingEm)).toEqual([onboarding(1), onboarding(2)]);
  });

  it("corte do servidor MENOR que a página (max_rows = 200): a leitura continua até a página vazia", async () => {
    const { admin, consultas } = quarentena([...ecos(450, 1, 0), ...ecos(1, 2, 450)], 200);
    const janelas = await janelasComEspera(admin as never, AGORA);
    expect(janelas.map((j) => j.onboardingEm)).toEqual([onboarding(1), onboarding(2)]);
    // As duas leituras (aguardando e largados) correm juntas. `aguardando` leu
    // 200 + 200 + 51 linhas — parar na primeira página "curta" (< 500) teria
    // perdido a janela 2 — e cada leitura terminou numa página VAZIA.
    expect(consultas.filter((n) => n > 0).sort((x, y) => y - x)).toEqual([200, 200, 51]);
    expect(consultas.filter((n) => n === 0)).toHaveLength(2);
  });

  it("a promoção largada no meio também põe a janela na lista", async () => {
    const { admin } = quarentena([...ecos(1, 1, 0), ...ecos(1, 3, 1, "promovido", "promovendo:historico_completo"), ...ecos(1, 4, 2, "promovido", "historico_completo")], 1000);
    const janelas = await janelasComEspera(admin as never, AGORA);
    expect(janelas.map((j) => j.onboardingEm)).toEqual([onboarding(1), onboarding(3)]);
  });

  it(`mais de ${LIMITE_DE_JANELAS} janelas: cada rodada leva ${LIMITE_DE_JANELAS}, e o rodízio cobre todas`, async () => {
    const total = 120;
    const linhas = Array.from({ length: total }, (_, j) => ecos(1, j, j)).flat();
    const { admin } = quarentena(linhas, 1000);
    const vistas = new Set<string>();
    for (let rodada = 0; rodada < 3; rodada++) {
      const janelas = await janelasComEspera(admin as never, new Date(AGORA.getTime() + rodada * 5 * 60_000));
      expect(janelas).toHaveLength(LIMITE_DE_JANELAS);
      expect(new Set(janelas.map((j) => j.onboardingEm)).size).toBe(LIMITE_DE_JANELAS);
      for (const j of janelas) vistas.add(j.onboardingEm);
    }
    expect(vistas.size).toBe(total);
  });

  it("a mesma rodada devolve a mesma lista (determinística)", async () => {
    const linhas = Array.from({ length: 70 }, (_, j) => ecos(1, j, j)).flat();
    const a = await janelasComEspera(quarentena(linhas, 1000).admin as never, AGORA);
    const b = await janelasComEspera(quarentena([...linhas].reverse(), 1000).admin as never, AGORA);
    expect(a).toEqual(b);
  });
});
