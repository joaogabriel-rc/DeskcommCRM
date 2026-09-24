/**
 * Nó MESSAGE — o passo de WhatsApp do flow.
 *
 * Reusa o MESMO caminho de saída que a automação e a UI usam
 * (`sendMessageHandler`), com `serviceForAutomation` resolvendo a conversa do
 * contato. Nenhuma segunda camada de WhatsApp.
 *
 * ═══ Botões ═══
 * Cada botão é uma SAÍDA do nó (`source_handle = 'button:<i>'`), e não
 * conteúdo decorativo: depois de enviar, a execução PARA e espera a escolha.
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
import { renderFlowTemplate } from "@/lib/flows/template";
import type { FlowNodeCtx, MessageNodeConfig, NodeOutcome } from "@/lib/flows/types";

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
 * A permissão da execução iniciada por um DISPARO (migration 0394).
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
    const envio = entradaDeEnvio(config, boundary.conversation_id, ctx.context);
    if (!envio.ok) return { kind: "failed", error: envio.error };

    await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: ctx.organizationId, contactId: guarda.contact.id },
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: ctx.requestId,
      },
      envio.input as Parameters<typeof sendMessageHandler>[2],
    );

    // Com botões, o nó é uma PERGUNTA: a execução para aqui até a resposta chegar.
    return (config.buttons ?? []).length > 0 ? { kind: "wait_button" } : { kind: "advance" };
  } catch (err) {
    return { kind: "failed", error: motivoDoErro(err) };
  }
}
