/**
 * GET/POST /api/v1/cron/meta-ecos-em-espera — a rede do resolvedor dos ecos em
 * espera (migration 0436).
 *
 * O caminho normal é o evento `meta.historico.chunk_guardado`, emitido a cada
 * pedaço de history guardado. Este cron
 * passa, a cada 5 minutos, por toda janela (organização, canal, onboarding) que
 * ainda tem eco `aguardando` ou promoção largada no meio — lida INTEIRA, em páginas,
 * porque o PostgREST corta cada resposta em `max_rows` — é o que impede um eco
 * de ficar parado para sempre porque um evento se perdeu, e é quem promove o eco
 * tardio quando o history PARA de chegar (nenhum pedaço novo acordaria ninguém).
 *
 * A organização de cada janela vem da própria linha guardada pelo servidor, nunca
 * de corpo de requisição. A auditoria é do resolvedor, por janela, e só quando a
 * rodada decidiu algo.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Agendado no serviço `scheduler`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import type { AlvoDosEcos } from "@/lib/channels/meta/ecos-em-espera";
import { resolverEcosEmEspera } from "@/lib/channels/meta/resolver-ecos-em-espera";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de janelas por rodada — as demais entram nas rodadas seguintes, em rodízio. */
export const LIMITE_DE_JANELAS = 50;

/** Tamanho da página na leitura da quarentena (o PostgREST corta em `max_rows`). */
const PAGINA = 500;

/** O intervalo do cron no `scheduler` — é ele que gira o rodízio das janelas. */
const INTERVALO_DO_CRON_MS = 5 * 60 * 1000;

export interface ResultadoDaRodada {
  janelas: number;
  historico: number;
  promovidos: number;
  duplicados: number;
  falhas: number;
  aguardando: number;
  erros: number;
}

type Admin = ReturnType<typeof createAdminClient>;
type LinhaDaJanela = { id: string; organization_id: string; channel_session_id: string; onboarding_em: string };

/** O pedaço do query builder que a paginação usa. */
interface ConsultaPaginavel {
  gt(coluna: string, valor: string): ConsultaPaginavel;
  order(coluna: string, opcoes: { ascending: boolean }): ConsultaPaginavel;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * TODAS as linhas de um filtro, em páginas por `id` (keyset): a próxima página
 * começa depois do último `id` lido, e a leitura só termina numa página VAZIA.
 * Assim nenhum corte do servidor (`max_rows`, menor ou maior que `PAGINA`) é lido
 * como "acabou", e uma linha que muda de estado no meio não desloca as outras —
 * o que um `offset` faria.
 */
async function todasAsLinhas(consulta: () => ConsultaPaginavel): Promise<LinhaDaJanela[]> {
  const saida: LinhaDaJanela[] = [];
  let depoisDe: string | null = null;
  for (;;) {
    const base = consulta();
    const { data, error } = await (depoisDe ? base.gt("id", depoisDe) : base).order("id", { ascending: true }).limit(PAGINA);
    if (error) throw new Error(`meta_ecos_em_espera: ${error.message}`);
    const pagina = (data ?? []) as LinhaDaJanela[];
    if (pagina.length === 0) return saida;
    saida.push(...pagina);
    depoisDe = pagina[pagina.length - 1]!.id;
  }
}

/**
 * As janelas com trabalho, sem repetição e em ordem determinística. A leitura é
 * COMPLETA (paginada); o teto por rodada é aplicado depois, em rodízio pelo
 * relógio do cron — com mais de `LIMITE_DE_JANELAS` janelas, cada rodada começa
 * num ponto diferente da lista, e nenhuma fica sempre de fora.
 */
export async function janelasComEspera(admin: Admin, agora: Date = new Date()): Promise<AlvoDosEcos[]> {
  const colunas = "id, organization_id, channel_session_id, onboarding_em";
  const quarentena = () => admin.from("meta_ecos_em_espera").select(colunas);
  const [aguardando, largados] = await Promise.all([
    todasAsLinhas(() => quarentena().eq("estado", "aguardando") as unknown as ConsultaPaginavel),
    todasAsLinhas(() => quarentena().eq("estado", "promovido").like("motivo", "promovendo:%") as unknown as ConsultaPaginavel),
  ]);

  const vistas = new Map<string, AlvoDosEcos>();
  for (const l of [...aguardando, ...largados]) {
    const chave = `${l.organization_id}|${l.channel_session_id}|${l.onboarding_em}`;
    if (!vistas.has(chave)) {
      vistas.set(chave, { organizationId: l.organization_id, channelSessionId: l.channel_session_id, onboardingEm: l.onboarding_em });
    }
  }
  const janelas = [...vistas.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, j]) => j);
  if (janelas.length <= LIMITE_DE_JANELAS) return janelas;

  const rodada = Math.floor(agora.getTime() / INTERVALO_DO_CRON_MS);
  const inicio = (rodada * LIMITE_DE_JANELAS) % janelas.length;
  return Array.from({ length: LIMITE_DE_JANELAS }, (_, i) => janelas[(inicio + i) % janelas.length]!);
}

export async function resolverRodada(admin: Admin, agora: Date, requestId: string): Promise<ResultadoDaRodada> {
  const janelas = await janelasComEspera(admin, agora);
  const total: ResultadoDaRodada = { janelas: janelas.length, historico: 0, promovidos: 0, duplicados: 0, falhas: 0, aguardando: 0, erros: 0 };
  for (const alvo of janelas) {
    try {
      const r = await resolverEcosEmEspera(admin, alvo, agora);
      total.historico += r.historico;
      total.promovidos += r.promovidos;
      total.duplicados += r.duplicados;
      total.falhas += r.falhas;
      total.aguardando += r.aguardando;
    } catch (err) {
      // Uma janela que falha não segura as outras; a próxima rodada tenta de novo.
      total.erros += 1;
      logger.error("[meta-ecos-em-espera] janela não resolvida", {
        requestId,
        organization_id: alvo.organizationId,
        channel_session_id: alvo.channelSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return total;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  try {
    return ok(await resolverRodada(createAdminClient(), new Date(), requestId), { requestId });
  } catch (err) {
    logger.error("[meta-ecos-em-espera] falhou", { requestId, error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to resolve waiting echoes.", 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
