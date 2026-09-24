import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/templates — o espelho local + o CONTRATO derivado de cada um.
 * POST /api/v1/channels/templates — força um sync com a Graph API; com
 *      `{ acao: "criar", channel_session_id, name, language, category, components }`
 *      CRIA o modelo na conta daquela conexão oficial (ver `criar-modelo.ts`).
 * PATCH /api/v1/channels/templates — salva (ou esquece) o link da mídia de um modelo.
 *
 * O contrato vai derivado no payload, e não guardado no banco, de propósito: guardar
 * o derivado criaria a segunda fonte da verdade que esta fase inteira existe para
 * eliminar. A tela e o montador de envio chamam a MESMA `deriveTemplateContract`.
 *
 * Nenhum campo aqui é "quantidade de parâmetros". O número é consequência dos slots;
 * se algum dia aparecer um campo editável com esse nome, o desenho vazou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarModeloOficial, respostaDoErroDeCriacao } from "@/lib/channels/meta/criar-modelo";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import {
  conexoesComModelos,
  modeloDaLinha,
  type ConexaoComModelos,
  type LinhaDoCatalogo,
} from "@/lib/channels/catalogo-de-modelos";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { mesclarValoresSalvos } from "@/lib/channels/meta/valores-salvos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Um template pronto para a tela: o que a Meta diz + o contrato derivado. */
export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  slots: Array<{
    key: string;
    expects: string;
    onde: string;
    /**
     * A chave de `template_values` para ESTE slot, montada por `slotKey` — a
     * mesma função que o montador do payload de envio usa.
     *
     * A `key` sozinha não endereça: um carrossel de dois cards tem dois slots
     * com a mesma `key`, e um cabeçalho de mídia colide com o `{{1}}` do corpo.
     * A tela teria de remontar o prefixo a partir de `onde`, que é rótulo
     * humano ("cabeçalho", "botão 1 (url)") e não sobrevive a isso. Montar a
     * chave de dois jeitos é o mismatch voltando pela porta dos fundos.
     */
    valueKey: string;
  }>;
  /**
   * Texto de cada componente que carrega parâmetro, INTEIRO e uma vez só.
   * Antes a tela mostrava o corpo repetido a cada slot, cada linha destacando o
   * seu e deixando o vizinho cru — correto e ilegível. A UI marca os `{{n}}`.
   */
  previews: Array<{ onde: string; text: string }>;
  /** A definição crua — de onde sai o texto que vai no corpo do envio. */
  components: unknown[];
  /**
   * Links de mídia que o operador salvou para este modelo, na chave de
   * `template_values`. O painel da janela fechada pré-preenche com eles.
   */
  savedValues: Record<string, string>;
}

type OrgGate =
  | { autorizado: true; orgId: string; userId: string }
  | { autorizado: false; resposta: NextResponse };

async function orgOrFail(requestId: string): Promise<OrgGate> {
  const authz = await requireRole("admin", { requestId, resource: "channels_templates" });
  if (!authz.ok) return { autorizado: false, resposta: authz.response };
  return { autorizado: true, orgId: authz.org.orgId, userId: authz.user.id };
}

/**
 * Criar um modelo. `components` viaja como o formulário monta
 * (`montarComponents`); a forma fina (o que a Meta aceita) é conferida por
 * `validarRascunhoOficial`. A organização NÃO está aqui de propósito: vem da
 * sessão — um `organization_id` no corpo é ignorado.
 */
const criarSchema = z.object({
  acao: z.literal("criar"),
  channel_session_id: z.string().uuid(),
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  category: z.enum(["AUTHENTICATION", "MARKETING", "UTILITY"]),
  components: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  const sessao = await metaSessionForOrg(r.orgId);
  const admin = createAdminClient();
  // As conexões OFICIAIS em que se pode criar modelo — a mesma lista do
  // catálogo central, recortada à fonte oficial.
  const conexoes: ConexaoComModelos[] = await conexoesComModelos(admin, r.orgId, { fonte: "oficial" }).catch(
    () => [],
  );
  const { data, error } = await admin
    .from("meta_templates")
    .select(
      "id, waba_id, channel_session_id, name, language, status, category, rejected_reason, quality_score, parameter_format, contract_hash, components, synced_at, saved_values",
    )
    .eq("organization_id", r.orgId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  // A derivação é a do CATÁLOGO central (`lib/channels/catalogo-de-modelos.ts`):
  // contrato, chave de cada espaço, prévias, links salvos. Esta rota só projeta
  // no formato que a tela de Conexões já consome — a mesma leitura que o nó de
  // mensagem dos Fluxos usa, para as duas telas nunca discordarem sobre o que
  // um modelo pede.
  const templates: TemplateView[] = ((data ?? []) as LinhaDoCatalogo[]).map((row) => {
    const m = modeloDaLinha(row);
    return {
      name: m.name,
      language: m.language,
      status: m.status,
      category: m.category,
      rejectedReason: m.rejectedReason,
      qualityScore: m.qualityScore,
      parameterFormat: m.parameterFormat,
      contractHash: m.contractHash,
      syncedAt: m.syncedAt,
      slots: m.espacos.map((e) => ({ key: e.key, expects: e.expects, onde: e.onde, valueKey: e.valueKey })),
      previews: m.previews,
      // A DEFINIÇÃO crua: o seletor da janela fechada monta o corpo a partir
      // daqui — `previews` filtra por `{{` e sai vazio para modelo sem variável.
      components: m.components,
      savedValues: m.savedValues,
    };
  });

  return ok({
    // `null` aqui não é "erro": é o estado de quem não tem canal oficial ATIVO —
    // nunca conectou, ou conectou e excluiu —, e a tela precisa distingui-lo de
    // "conectado, porém sem template".
    waba: sessao?.wabaId ?? null,
    conexoes,
    templates,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  // Corpo com `acao: "criar"` cria; qualquer outro (inclusive vazio, que é o
  // que o botão de sincronizar manda) segue sincronizando como sempre.
  const corpo = (await req.json().catch(() => null)) as { acao?: unknown } | null;
  if (corpo?.acao === "criar") return criar(r.orgId, r.userId, corpo, requestId);

  const sessao = await metaSessionForOrg(r.orgId);
  if (!sessao?.wabaId) {
    return fail("invalid_request", "no_meta_channel", 400, { requestId });
  }

  // A credencial vem da SESSÃO que o operador conectou na tela, com o ambiente só
  // como RESERVA — a mesma porta que `send`, `checkHealth` e `fetchInboundMedia` já
  // usam. Antes disto este 400 olhava só `META_SYSTEM_USER_TOKEN`: numa instalação que
  // conectou o número pela TELA, "Sincronizar modelos" respondia
  // `400 missing_meta_token` a quem tinha credencial salva e visível na própria tela,
  // e o 2º número oficial da instalação nunca sincronizava um modelo.
  //
  // A ORDEM dos desfechos NÃO muda: sem canal oficial a resposta continua
  // `no_meta_channel`; com canal e sem credencial nenhuma (nem na sessão, nem no
  // ambiente) continua `missing_meta_token` 400 — o que muda é só de ONDE a
  // credencial sai quando existe.
  const creds = await resolveMetaCreds(createAdminClient(), {
    organizationId: r.orgId,
    phoneNumberId: sessao.phoneNumberId ?? "",
  });
  if (!creds) return fail("invalid_request", "missing_meta_token", 400, { requestId });

  try {
    const counts = await syncTemplates({
      organizationId: r.orgId,
      wabaId: sessao.wabaId,
      token: creds.token,
      graphVersion: creds.graphVersion,
    });
    return ok(counts);
  } catch (err) {
    // A falha da Graph API vira mensagem legível na tela, não 500 mudo — o
    // operador precisa saber se é token vencido, WABA errada ou rede.
    return fail("internal_error", err instanceof Error ? err.message : "sync_failed", 502, {
      requestId,
    });
  }
}

/**
 * Salva o link da mídia de um modelo, para o painel da janela fechada
 * pré-preencher no próximo disparo. Valor vazio esquece o link.
 *
 * Só slot de mídia e só `https://` — ver `lib/channels/meta/valores-salvos.ts`.
 * Mesmo papel do sync (`admin`), e bloqueado em sessão de suporte, porque
 * escreve na configuração do canal.
 *
 * Grava em TODAS as linhas do mesmo nome e idioma da organização: a tela lista
 * o modelo uma vez só, e dois números oficiais com a mesma definição
 * divergiriam em silêncio se só um recebesse o link.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    language?: unknown;
    values?: unknown;
  } | null;
  const valores = body?.values;
  if (
    typeof body?.name !== "string" ||
    typeof body?.language !== "string" ||
    !valores ||
    typeof valores !== "object" ||
    Array.isArray(valores) ||
    !Object.values(valores).every((v) => typeof v === "string")
  ) {
    return fail("validation_failed", "esperado { name, language, values: { chave: link } }", 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: linhas, error } = await admin
    .from("meta_templates")
    .select("id, name, language, parameter_format, components, saved_values")
    .eq("organization_id", r.orgId)
    .eq("name", body.name)
    .eq("language", body.language);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!linhas || linhas.length === 0) {
    return fail("not_found", "modelo não encontrado", 404, { requestId });
  }

  // Confere TUDO antes de escrever qualquer linha: recusar a segunda depois de
  // gravar a primeira deixaria os números divergindo.
  const planos: Array<{ id: string; valores: Record<string, string> }> = [];
  for (const linha of linhas) {
    const contrato = deriveTemplateContract({
      name: linha.name,
      language: linha.language,
      parameter_format: linha.parameter_format,
      components: linha.components as never,
    });
    const m = mesclarValoresSalvos(
      contrato,
      (linha.saved_values ?? {}) as Record<string, unknown>,
      valores as Record<string, string>,
    );
    if (!m.ok) {
      return fail("validation_failed", m.motivo, 422, { requestId, details: { chave: m.chave } });
    }
    planos.push({ id: linha.id, valores: m.valores });
  }

  for (const plano of planos) {
    const { error: erro } = await admin
      .from("meta_templates")
      .update({ saved_values: plano.valores })
      .eq("organization_id", r.orgId)
      .eq("id", plano.id);
    if (erro) return fail("internal_error", erro.message, 500, { requestId });
  }

  return ok({ savedValues: planos[0]!.valores });
}

async function criar(orgId: string, userId: string, corpo: unknown, requestId: string): Promise<NextResponse> {
  const parsed = criarSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", "Faltam conexão, nome, idioma, categoria ou conteúdo.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const p = parsed.data;
  try {
    const { modelo, providerTemplateId } = await criarModeloOficial(createAdminClient(), {
      organizationId: orgId,
      channelSessionId: p.channel_session_id,
      draft: { name: p.name, language: p.language, category: p.category, components: p.components },
    });
    await audit({
      action: "template.created",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: p.channel_session_id,
      requestId,
      metadata: { name: modelo.name, language: modelo.language, status: modelo.status, provider_template_id: providerTemplateId },
    });
    return ok({ modelo, provider_template_id: providerTemplateId }, { requestId, status: 201 });
  } catch (err) {
    // A frase da Meta (ou a nossa) CHEGA ao operador: é ela que distingue nome
    // inválido de token vencido de conta errada. Nunca carrega o token.
    const mensagem = err instanceof Error ? err.message : "erro";
    const { status, code } = respostaDoErroDeCriacao(mensagem);
    // A frase vai limpa para a tela; o desfecho técnico (credencial, conta,
    // rede…) vai em `details.motivo`, para quem integra e para o log.
    const prefixo = /^([a-z_]+):\s*/.exec(mensagem);
    return fail(code, prefixo ? mensagem.slice(prefixo[0].length) : mensagem, status, {
      requestId,
      details: { motivo: prefixo?.[1] ?? null },
    });
  }
}
