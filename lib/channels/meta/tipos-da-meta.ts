/**
 * TODO TIPO QUE A META MANDA VIRA UM TIPO QUE O BANCO ACEITA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 * O parser repassava a `messages.type` o `type` cru da Meta. A constraint
 * `messages_type_check` só aceita o vocabulário do CRM (texto, mídia, cartão,
 * localização, reação, sistema, modelo), e todo o resto falhava com 23514 — e a
 * mensagem do cliente sumia. Medido na produção, de 01 a 08/11/2026: 183
 * mensagens assim, nenhuma recuperável (`unsupported` 108, `interactive` 53,
 * `revoke` 12, `edit` 7, `order` 3).
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *   - tipo que o CRM já conhece → passa como está (nada muda para eles);
 *   - `order`, `interactive` e `nfm_reply` → `text` LEGÍVEL, com o objeto
 *     original inteiro em `extras` (vai para `messages.metadata`);
 *   - `unsupported` e tipo que ninguém previu → `text` com um rótulo, e
 *     `conteudoIndisponivel`: a Meta não entregou o conteúdo, e nem a IA nem
 *     automação nenhuma deve responder a um rótulo do próprio CRM;
 *   - `revoke`/`edit` NÃO passam por aqui: não são mensagem nova, são
 *     alteração de uma existente (ver `alteracaoDaMensagem` em `webhook.ts`).
 *
 * `TIPOS_QUE_O_PARSER_PRODUZ` é a lista fechada do que sai daqui. A cerca
 * `tests/unit/meta-tipos-cabem-na-constraint.test.ts` compara essa lista com a
 * ÚLTIMA definição de `messages_type_check` no baseline — se uma das duas
 * mudar sem a outra, o teste reprova antes de a mensagem sumir em produção.
 *
 * Puro: nada aqui toca banco nem rede.
 */

/** Tudo o que este módulo pode devolver em `type`. Fechado de propósito. */
export const TIPOS_QUE_O_PARSER_PRODUZ = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "reaction",
  "system",
] as const;

export type TipoDoCrm = (typeof TIPOS_QUE_O_PARSER_PRODUZ)[number];

/** Tipos da Meta que já têm o MESMO nome no CRM e passam sem conversão. */
const TIPOS_NATIVOS = new Set<string>([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "reaction",
  "system",
]);

/**
 * Os 19 subtipos de `unsupported` documentados pela Meta
 * (developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported),
 * com o nome que quem atende reconhece. Subtipo fora da lista cai no genérico.
 */
export const ROTULO_DO_NAO_SUPORTADO: Readonly<Record<string, string>> = {
  button: "resposta de botão",
  edit: "edição de mensagem",
  errors: "mensagem com erro",
  gif: "GIF",
  group_invite: "convite de grupo",
  hsm: "mensagem de modelo",
  image: "imagem",
  interactive: "mensagem interativa",
  keep_in_chat: "mensagem mantida na conversa",
  link_preview: "prévia de link",
  list: "lista",
  location: "localização",
  media_placeholder: "mídia",
  order: "pedido",
  pin: "mensagem fixada",
  poll_creation: "enquete",
  poll_update: "voto em enquete",
  product: "produto",
  reaction: "reação",
};

/** Erro que a Meta manda quando a mensagem existe mas ainda não está disponível. */
const ERRO_MENSAGEM_INDISPONIVEL = 131060;

export interface ConteudoConvertido {
  type: TipoDoCrm;
  text: string | null;
  /** Vai para `messages.metadata`, ao lado de `meta_original`. */
  extras: Record<string, unknown>;
  /**
   * A Meta não entregou o conteúdo: o CRM só tem um rótulo. A ingestão não
   * despacha IA, e o banco marca o evento para os handlers que respondem.
   */
  conteudoIndisponivel: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function lista(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function juntar(partes: Array<string | null>): string | null {
  const ok = partes.filter((p): p is string => p !== null);
  return ok.length > 0 ? ok.join("\n") : null;
}

/** O tipo da Meta já é um tipo do CRM com o mesmo nome? */
export function ehTipoNativo(tipo: string): boolean {
  return TIPOS_NATIVOS.has(tipo);
}

/**
 * `unsupported`: a Cloud API avisa que a mensagem existe, mas não manda o
 * conteúdo (enquete, GIF, convite de grupo…). O CRM guarda que ela chegou, de
 * que tipo era e o erro que a Meta deu — sem inventar o que não veio.
 */
export function naoSuportada(raw: Record<string, unknown>): ConteudoConvertido {
  const subtipo = str(obj(raw.unsupported).type);
  const erros = lista(raw.errors);
  const indisponivelAgora = erros.some((e) => Number(e.code) === ERRO_MENSAGEM_INDISPONIVEL);
  const rotulo = subtipo ? ROTULO_DO_NAO_SUPORTADO[subtipo] : undefined;
  const text = indisponivelAgora
    ? "[Mensagem indisponível no momento — o WhatsApp oficial ainda não entregou o conteúdo]"
    : rotulo
      ? `[${primeiraMaiuscula(rotulo)} — tipo de mensagem que o WhatsApp oficial não entrega ao CRM]`
      : "[Tipo de mensagem que o WhatsApp oficial não entrega ao CRM]";
  return {
    type: "text",
    text,
    extras: { meta_tipo: "unsupported", unsupported: { type: subtipo, errors: erros } },
    conteudoIndisponivel: true,
  };
}

function primeiraMaiuscula(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * `order`: o cliente fechou um pedido pelo catálogo. É um cliente comprando —
 * segue o fluxo normal de atendimento. O pedido inteiro fica em `extras.order`.
 */
export function pedido(raw: Record<string, unknown>): ConteudoConvertido {
  const order = obj(raw.order);
  const itens = lista(order.product_items);
  const linhas = itens.map((i) => {
    const qtd =
      typeof i.quantity === "number" || typeof i.quantity === "string" ? String(i.quantity) : "?";
    const produto = str(i.product_retailer_id) ?? "produto";
    const preco =
      i.item_price !== undefined && i.item_price !== null
        ? ` — ${String(i.item_price)}${str(i.currency) ? ` ${str(i.currency)}` : ""}`
        : "";
    return `• ${qtd} × ${produto}${preco}`;
  });
  const cabecalho = `Pedido pelo catálogo: ${itens.length} ${itens.length === 1 ? "item" : "itens"}`;
  return {
    type: "text",
    text: juntar([cabecalho, ...linhas, str(order.text)]),
    extras: { meta_tipo: "order", order },
    conteudoIndisponivel: false,
  };
}

/**
 * `nfm_reply`: o contato respondeu um formulário do WhatsApp Flows. A resposta
 * vem em `response_json` (texto JSON); vira "campo: valor" legível, e o original
 * fica em `extras.flow`. `flow_token` é técnico e fica só no original.
 */
export function respostaDeFormulario(raw: Record<string, unknown>): ConteudoConvertido {
  const nfm = obj(obj(raw.interactive).nfm_reply);
  let respostas: Record<string, unknown> | null = null;
  const cru = nfm.response_json;
  if (typeof cru === "string") {
    try {
      respostas = obj(JSON.parse(cru));
    } catch {
      respostas = null;
    }
  } else if (cru && typeof cru === "object") {
    respostas = obj(cru);
  }
  const linhas = Object.entries(respostas ?? {})
    .filter(([campo]) => campo !== "flow_token")
    .map(
      ([campo, valor]) =>
        `• ${campo}: ${typeof valor === "string" ? valor : JSON.stringify(valor)}`,
    );
  return {
    type: "text",
    text: juntar([
      `Resposta de formulário${str(nfm.name) ? ` (${str(nfm.name)})` : ""}`,
      ...linhas,
      linhas.length === 0 ? str(nfm.body) : null,
    ]),
    extras: {
      meta_tipo: "nfm_reply",
      flow: { name: str(nfm.name), body: str(nfm.body), response: respostas ?? cru ?? null },
    },
    conteudoIndisponivel: false,
  };
}

/**
 * `interactive` que NÃO é resposta de botão/lista — o caso medido é o eco de uma
 * mensagem com botões ou lista que a empresa mandou pelo app Business. Cabeçalho,
 * corpo, rodapé, botões, seções e link viram texto legível; o objeto inteiro fica
 * em `extras.interactive`.
 */
export function interativa(raw: Record<string, unknown>): ConteudoConvertido {
  const i = obj(raw.interactive);
  const action = obj(i.action);
  const botoes = lista(action.buttons).map(
    (b) => str(obj(b.reply).title) ?? str(b.title) ?? str(obj(b.reply).id),
  );
  const secoes = lista(action.sections).flatMap((s) => {
    const titulo = str(s.title);
    const linhas = lista(s.rows).map((r) => {
      const t = str(r.title);
      const d = str(r.description);
      return t ? `• ${t}${d ? ` — ${d}` : ""}` : null;
    });
    return [titulo ? `${titulo}:` : null, ...linhas];
  });
  const link = obj(action.parameters);
  const textoDoLink =
    str(link.display_text) && str(link.url)
      ? `${str(link.display_text)}: ${str(link.url)}`
      : str(link.url);
  return {
    type: "text",
    text:
      juntar([
        str(obj(i.header).text),
        str(obj(i.body).text),
        str(obj(i.footer).text),
        ...botoes.map((b) => (b ? `[${b}]` : null)),
        str(action.button) && secoes.length > 0 ? `[${str(action.button)}]` : null,
        ...secoes,
        textoDoLink,
      ]) ?? "[Mensagem interativa]",
    extras: { meta_tipo: "interactive", interactive: i },
    conteudoIndisponivel: false,
  };
}

/** Tipo que nem a documentação de hoje lista: entra com rótulo, nunca é rejeitado. */
export function tipoDesconhecido(tipo: string): ConteudoConvertido {
  return {
    type: "text",
    text: `[Mensagem do tipo "${tipo.slice(0, 40)}", que o CRM ainda não reconhece]`,
    extras: { meta_tipo: tipo.slice(0, 64) },
    conteudoIndisponivel: true,
  };
}

/**
 * Localização: os mesmos nomes de campo que a bolha da Inbox já lê em
 * `metadata.location` (`lib/messaging/localizacao.ts`).
 */
export function localizacaoDaMeta(raw: Record<string, unknown>): Record<string, unknown> | null {
  const l = obj(raw.location);
  const latitude = Number(l.latitude);
  const longitude = Number(l.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    ...(str(l.name) ? { name: str(l.name) } : {}),
    ...(str(l.address) ? { address: str(l.address) } : {}),
    ...(str(l.url) ? { url: str(l.url) } : {}),
  };
}

/**
 * Reação: o emoji e o `wamid` da mensagem reagida. Emoji vazio é a Meta avisando
 * que a reação foi REMOVIDA — guardado como `emoji: null`, não descartado.
 */
export function reacaoDaMeta(raw: Record<string, unknown>): {
  emoji: string | null;
  message_id: string | null;
} {
  const r = obj(raw.reaction);
  return { emoji: str(r.emoji), message_id: str(r.message_id) };
}
