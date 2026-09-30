/**
 * Nó MESSAGE — o passo de WhatsApp do flow.
 *
 * Reusa o MESMO caminho de saída que a automação e a UI usam
 * (`sendMessageHandler`), com `serviceForAutomation` resolvendo a conversa do
 * contato. Nenhuma segunda camada de WhatsApp.
 *
 * ═══ Blocos, botões e Próximo passo (migration 0502) ═══
 * O nó é uma sequência de blocos (texto, imagem, atraso) — `lib/flows/blocos.ts`.
 * O botão de FLUXO é uma saída do nó (`button:<id>`; `button:<i>` no formato
 * antigo); o de URL abre o site e não é saída. O Próximo passo é a saída padrão
 * (sem `source_handle`) e existe com ou sem botão: o fluxo segue por ele assim
 * que o último bloco sai, e um clique que chegue depois DESVIA a execução para
 * o botão (`resumeWithLateButtonClick`). Sem Próximo passo ligado, a execução
 * ESPERA o clique, como sempre esperou.
 *
 * ── LIMITAÇÃO MEDIDA, não presumida ─────────────────────────────────────────
 *
 * A camada de canal deste produto NÃO implementa botão interativo nativo.
 * Medido em 2026-09-20, e não deduzido: `messageTypeSchema`
 * (lib/schemas/messaging.ts) tem nove tipos e nenhum é interativo;
 * `OutboundEnvelope` (lib/channels/types.ts) não tem campo de botão; NENHUM dos
 * adapters de `lib/channels/adapters/` traduz botão; e a ingestão não reconhece
 * resposta interativa. Não há capacidade a perguntar (`capabilitiesOf`) porque
 * a matriz ainda não tem a coluna — ela entra no passo 3 da lista abaixo.
 *
 * Enquanto for assim, as opções saem como LISTA NUMERADA no texto e a resposta
 * é casada por número ("1"), pelo rótulo, ou pelo ID CANÔNICO da saída
 * (`button:0`) — ver `casarRespostaDeBotao`.
 *
 * ── O que precisa mudar para o botão nativo, na ordem ───────────────────────
 *
 *   1. `lib/schemas/messaging.ts`   tipo `interactive` (ou `buttons` no envio)
 *   2. `lib/channels/types.ts`      `buttons?: {id,title}[]` em OutboundEnvelope
 *                                   e `interactiveButtons` em ChannelCapabilities
 *   3. `lib/channels/capabilities.ts` a matriz por provider
 *   4. `lib/channels/adapters/*.ts` a tradução para o payload de cada um
 *   5. `app/api/v1/messages/_handler.ts` carregar os botões para o envelope
 *   6. a ingestão do canal            gravar o ID do botão escolhido no corpo
 *   7. `textoDasOpcoes` aqui          parar de anexar a lista quando a
 *                                     capability disser que o canal manda botão
 *
 * O MOTOR não entra nessa lista, e é de propósito: `resumeWithButtonReply`
 * recebe texto e devolve o índice da saída, e `casarRespostaDeBotao` já aceita
 * o id canônico que uma implementação nativa emitiria. Os passos 1 a 7 são
 * todos de CANAL.
 *
 * ═══ Janela de 24 horas ═══
 * `inside_24h` (padrão) manda texto livre. `outside_24h` manda TEMPLATE
 * aprovado — o único caminho que a plataforma aceita fora da janela — pelo
 * mesmo handler (`type: "template"`), que já sabe resolver o canal oficial.
 * Sem template configurado o nó falha com motivo explícito, em vez de mandar
 * texto livre que o provedor recusaria.
 */
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { ActionCtx } from "@/lib/automation/types";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { motivoDoErro } from "@/lib/flows/erro";
import { createHash } from "node:crypto";

import { espacarEnvio } from "@/lib/automation/throttle";
import {
  ATRASO_MAX_SEGUNDOS,
  ATRASO_MIN_SEGUNDOS,
  blocosDaMensagem,
  numeroInicialDoBloco,
  saidasDeBotao,
  textoDoBloco,
  type BlocoDeImagem,
} from "@/lib/flows/blocos";
import { renderFlowTemplate } from "@/lib/flows/template";
import type { FlowNodeCtx, MessageNodeConfig, NodeOutcome } from "@/lib/flows/types";
import { desfechoDoEnvio, erroDoDesfecho } from "@/lib/messaging/desfecho-do-envio";

/** FlowNodeCtx é estruturalmente um ActionCtx (mesmos campos) — só o nome do arquivo muda. */
function asActionCtx(ctx: FlowNodeCtx): ActionCtx {
  return ctx;
}

/** O corpo que sai no WhatsApp: texto + as opções numeradas, quando houver. */
export function textoDasOpcoes(config: MessageNodeConfig, context: Record<string, unknown>): string {
  const corpo = config.body ? renderFlowTemplate(config.body, context) : "";
  const botoes = config.buttons ?? [];
  if (!botoes.length) return corpo;
  const linhas = botoes.map((b, i) => `${i + 1}. ${b.label}`);
  return [corpo, ...linhas].filter(Boolean).join("\n");
}

/**
 * Casa a resposta do contato com um botão, em quatro tentativas, da mais
 * confiável para a mais frouxa:
 *
 *   1. o ID CANÔNICO da saída (`button:0`) — é o que uma implementação de botão
 *      nativo colocaria no payload da resposta, e é o MESMO identificador que
 *      `flow_edges.source_handle` guarda. Está aqui para que o dia do botão
 *      nativo não precise tocar no motor: basta a ingestão gravar esse id.
 *   2. o número que a lista numerada mostrou ("1" → índice 0);
 *   3. o rótulo exato, sem caixa;
 *   4. o rótulo contido na frase ("quero a opção Sim").
 *
 * A ordem importa: um botão rotulado "2" faria a tentativa 3 casar com o botão
 * errado se ela viesse antes da 2.
 */
export function casarRespostaDeBotao(config: MessageNodeConfig, resposta: string): number | null {
  const botoes = config.buttons ?? [];
  if (!botoes.length) return null;
  const limpo = resposta.trim();

  // 1. id canônico da saída, exatamente como o edge o nomeia.
  const canonico = /^button:(\d+)$/.exec(limpo);
  if (canonico) {
    const i = Number(canonico[1]);
    return i >= 0 && i < botoes.length ? i : null;
  }

  const numero = Number(limpo);
  if (Number.isInteger(numero) && numero >= 1 && numero <= botoes.length) return numero - 1;
  const minusculo = limpo.toLowerCase();
  const porRotulo = botoes.findIndex((b) => b.label.toLowerCase() === minusculo);
  if (porRotulo >= 0) return porRotulo;
  const porConteudo = botoes.findIndex((b) => b.label && minusculo.includes(b.label.toLowerCase()));
  return porConteudo >= 0 ? porConteudo : null;
}

/** O payload de envio, conforme a janela escolhida. Separado para poder ser testado sem rede. */
export function entradaDeEnvio(
  config: MessageNodeConfig,
  conversationId: string,
  context: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (config.window_mode === "outside_24h") {
    if (!config.template_name || !config.template_language) {
      return { ok: false, error: "template_incompleto: fora da janela de 24h exige template aprovado" };
    }
    const valores = Object.fromEntries(
      Object.entries(config.template_values ?? {}).map(([slot, valor]) => [
        slot,
        renderFlowTemplate(valor, context),
      ]),
    );
    return {
      ok: true,
      input: {
        conversation_id: conversationId,
        type: "template",
        template_name: config.template_name,
        template_language: config.template_language,
        template_values: valores,
      },
    };
  }
  const body = textoDasOpcoes(config, context);
  if (!body.trim()) return { ok: false, error: "missing_body" };
  return { ok: true, input: { conversation_id: conversationId, type: "text", body } };
}

/**
 * A permissão da execução iniciada por um DISPARO (migration 0399).
 *
 * Não cria autorização: usa a que o disparo materializou no agendamento e a
 * RECONFERE com `assertServiceBoundarySupabase` — a mesma régua do worker dos
 * disparos no modo guiado. Se o mundo mudou (atendimento fechado, conversa de
 * outro estado), recusa. Antes disso, três conferências de escopo que a
 * permissão não faz sozinha:
 *
 *   - organização e contato da permissão são os da execução;
 *   - o número que o passo fixou (o do modelo aprovado) é o da conversa da
 *     permissão — a mesma pergunta de `serviceForAutomation` quando há número.
 */
async function servicoDoDisparo(
  ctx: FlowNodeCtx,
  autorizado: ServiceBoundary,
  contactId: string,
  sessionId?: string,
): Promise<ServiceBoundary> {
  if (autorizado.organization_id !== ctx.organizationId || autorizado.contact_id !== contactId) {
    throw new Error("service_scope_mismatch");
  }
  if (sessionId) {
    const { data, error } = await ctx.admin
      .from("conversations")
      .select("channel_session_id")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .eq("id", autorizado.conversation_id)
      .maybeSingle();
    if (error) throw error;
    if ((data as { channel_session_id?: string } | null)?.channel_session_id !== sessionId) {
      throw new Error("service_channel_mismatch");
    }
  }
  await assertServiceBoundarySupabase(ctx.admin, autorizado);
  return autorizado;
}

/** Onde mora o arquivo de um bloco de imagem, e para onde ele é copiado no envio. */
const BUCKET = "whatsapp-media";

/**
 * A imagem do bloco vai para a PASTA DA CONVERSA antes de sair — o mesmo
 * desenho das fotos do catálogo (`lib/agent-engine/agent/fotos-do-produto.ts`).
 * A cópia é da conversa: a inbox a mostra, a retenção de mídia e a LGPD a
 * apagam com a conversa, e o arquivo do FLUXO (`<org>/flows/<fluxo>/…`) não é
 * tocado por nenhuma delas. O destino é determinístico por arquivo de origem:
 * reenviar ou retomar depois de uma queda reaproveita a cópia.
 */
async function entradaDaImagem(
  ctx: FlowNodeCtx,
  bloco: BlocoDeImagem,
  conversationId: string,
): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; error: string }> {
  const origem = bloco.media_storage_path?.trim();
  if (!origem) return { ok: false, error: "imagem_sem_arquivo" };
  // O arquivo é DESTA organização — nunca um caminho de outra, vindo do config.
  if (!origem.startsWith(`${ctx.organizationId}/flows/`)) return { ok: false, error: "imagem_fora_da_organizacao" };
  const ext = /\.([a-z0-9]{2,5})$/i.exec(origem)?.[1]?.toLowerCase() ?? "jpg";
  const marca = createHash("sha256").update(origem).digest("hex").slice(0, 16);
  const destino = `${ctx.organizationId}/${conversationId}/fluxo-${marca}.${ext}`;
  const { error } = await ctx.admin.storage.from(BUCKET).copy(origem, destino);
  if (error && !/already exists|duplicate/i.test(error.message) && (error as { statusCode?: string }).statusCode !== "409") {
    return { ok: false, error: `imagem_nao_copiada: ${error.message.slice(0, 120)}` };
  }
  const legenda = bloco.legenda ? renderFlowTemplate(bloco.legenda, ctx.context) : "";
  return {
    ok: true,
    input: {
      conversation_id: conversationId,
      type: "image",
      media_storage_path: destino,
      ...(bloco.media_mime ? { media_mime: bloco.media_mime } : {}),
      ...(legenda.trim() ? { body: legenda } : {}),
    },
  };
}

/**
 * Executa o nó de mensagem.
 *
 * Fora da janela: UM modelo aprovado (a regra da plataforma não muda com os
 * blocos). Dentro: os blocos em ordem, a partir de `ctx.cursor`. Cada envio é
 * conferido (`desfechoDoEnvio`) e grava o cursor; um bloco de ATRASO devolve
 * `wait_delay` com o cursor do bloco seguinte — o motor persiste e o relógio
 * retoma o MESMO nó dali. Entre dois envios seguidos do nó, o espaçamento
 * anti-banimento de sempre (`espacarEnvio`).
 *
 * No fim, se houve botão de fluxo, o nó pede ao motor para ESCUTAR: seguir pelo
 * Próximo passo com os botões ainda clicáveis (ou esperar o clique, se o nó não
 * tem Próximo passo ligado).
 */
export async function executeMessageNode(ctx: FlowNodeCtx, config: MessageNodeConfig): Promise<NodeOutcome> {
  const actionCtx = asActionCtx(ctx);
  const guarda = checarGuardasDeContato(actionCtx);
  if (!guarda.ok) return { kind: "failed", error: `contato_bloqueado:${guarda.reason}` };

  try {
    // Execução de DISPARO carrega a permissão do agendamento; execução de
    // EVENTO a deriva do evento. São os dois caminhos que já existiam no
    // produto (worker dos disparos e automação) — nenhum terceiro.
    const boundary = ctx.servicoAutorizado
      ? await servicoDoDisparo(ctx, ctx.servicoAutorizado, guarda.contact.id, config.channel_session_id)
      : await serviceForAutomation(actionCtx, guarda.contact.id, config.channel_session_id);

    const enviar = async (input: Record<string, unknown>): Promise<string | null> => {
      const enviada = await sendMessageHandler(
        ctx.admin,
        {
          organization_id: ctx.organizationId,
          serviceBoundary: boundary,
          proactiveContext: { organizationId: ctx.organizationId, contactId: guarda.contact.id },
          actor: { type: "webhook_source", id: ctx.ruleId },
          requestId: ctx.requestId,
          ...(ctx.broadcastRecipientId ? { broadcastRecipientId: ctx.broadcastRecipientId } : {}),
        },
        input as Parameters<typeof sendMessageHandler>[2],
      );
      // O handler NÃO lança quando o canal recusa: devolve a linha `failed`.
      // Ignorar o retorno fazia a recusa virar avanço — e o disparo, sucesso.
      const desfecho = desfechoDoEnvio(enviada);
      return desfecho.kind === "recusado" ? erroDoDesfecho(desfecho) : null;
    };

    const escutar = saidasDeBotao(config).length > 0;

    if (config.window_mode === "outside_24h") {
      const envio = entradaDeEnvio(config, boundary.conversation_id, ctx.context);
      if (!envio.ok) return { kind: "failed", error: envio.error };
      const erro = await enviar(envio.input);
      if (erro) return { kind: "failed", error: erro };
      return { kind: "advance", ...(escutar ? { escutar: true } : {}) };
    }

    const blocos = blocosDaMensagem(config);
    if (!blocos.some((b) => b.tipo !== "atraso")) return { kind: "failed", error: "missing_body" };

    let enviouNesteTrecho = false;
    let numero = numeroInicialDoBloco(blocos, ctx.cursor ?? 0);
    for (let i = ctx.cursor ?? 0; i < blocos.length; i++) {
      const bloco = blocos[i]!;
      if (bloco.tipo === "atraso") {
        const s = Math.min(Math.max(Number(bloco.segundos) || ATRASO_MIN_SEGUNDOS, ATRASO_MIN_SEGUNDOS), ATRASO_MAX_SEGUNDOS);
        return { kind: "wait_delay", until: new Date(Date.now() + s * 1000).toISOString(), cursor: i + 1 };
      }

      let input: Record<string, unknown> | null = null;
      if (bloco.tipo === "texto") {
        const r = textoDoBloco(bloco, ctx.context, numero);
        numero = r.proximoNumero;
        if (r.texto.trim()) input = { conversation_id: boundary.conversation_id, type: "text", body: r.texto };
      } else {
        const r = await entradaDaImagem(ctx, bloco, boundary.conversation_id);
        if (!r.ok) return { kind: "failed", error: r.error };
        input = r.input;
      }

      if (input) {
        // Blocos seguidos sem atraso ainda são envios AUTOMATIZADOS do mesmo
        // número: o espaçamento anti-banimento vale entre eles.
        if (enviouNesteTrecho) await espacarEnvio(`conversa:${boundary.conversation_id}`);
        const erro = await enviar(input);
        if (erro) return { kind: "failed", error: erro };
        enviouNesteTrecho = true;
      }
      await ctx.salvarCursor?.(i + 1);
    }

    return { kind: "advance", ...(escutar ? { escutar: true } : {}) };
  } catch (err) {
    return { kind: "failed", error: motivoDoErro(err) };
  }
}
