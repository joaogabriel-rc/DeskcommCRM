/**
 * Webhook da Meta (Cloud API) — verificação e parse. **Puro e síncrono**: nada
 * aqui toca banco nem rede, para que cada regra seja testável sem ambiente.
 *
 * Duas diferenças em relação ao webhook do WAHA (`lib/waha/ingest.ts`), e as duas
 * já morderam quem tentou reaproveitar o outro:
 *
 *   1. **HMAC SHA-256, não SHA-512**, e o header vem prefixado: `X-Hub-Signature-256:
 *      sha256=<hex>`. Comparar sem tirar o prefixo reprova sempre.
 *   2. **A chave é o App Secret**, não um segredo por sessão. Um App Secret vale para
 *      todas as WABAs do app — por isso a rota ainda usa token no path, para amarrar
 *      o payload a UMA organização antes de confiar nele.
 *
 * `hub.challenge` (GET) faz parte do protocolo: a Meta só passa a entregar eventos
 * depois que o endpoint devolve o desafio **em texto puro** — não JSON, não
 * `{data:...}`. Envelopar quebra a verificação com uma mensagem inútil no dashboard.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { parseMetaInboundContact } from "@/lib/channels/meta/contact-card";
import { logger } from "@/lib/logger";
import type { SharedContact } from "@/lib/messaging/contact-card";
import type { MetaWebhookEnvelope } from "./envelope";

/** Assinatura da Meta: `sha256=<hex>` no header `X-Hub-Signature-256`. */
/**
 * A instalação consegue RECEBER pelo canal oficial? — as duas metades.
 *
 * São dois segredos com papéis diferentes, e conferir só um produz o pior tipo
 * de tela: a que diz "pronto" sobre algo que não funciona.
 *
 *   META_WEBHOOK_VERIFY_TOKEN → responde o handshake GET, em que a Meta valida
 *                               o endereço. Sem ele o webhook nem é aceito.
 *   META_APP_SECRET           → valida a ASSINATURA de cada mensagem que chega
 *                               (`verifyMetaSignature`, logo abaixo). Sem ele,
 *                               o handshake passa e TODO POST assinado morre em
 *                               401 `invalid_signature` — o número envia e
 *                               nunca recebe, sem erro em lugar nenhum.
 *
 * Nenhum dos dois é escrito pelo `install.sh` (`git grep 'META_' -- '*.sh'`
 * devolve vazio): numa instalação recém-feita os dois estão ausentes, que é
 * exatamente quando o aviso precisa aparecer.
 *
 * `.trim() !== ""` e não `Boolean()`: o contrato do `.env` deste projeto é que
 * vazio é ausente — o template gera `CHAVE=` e é assim que `preenchida()` em
 * `lib/instalacao/ambiente.ts:61` já decide.
 */
// O mesmo tipo que `lib/instalacao/ambiente.ts` usa para ler `.env`:
// `NodeJS.ProcessEnv` exige `NODE_ENV` e obrigaria todo teste a montá-lo.
export function metaPodeReceber(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const cheia = (nome: string): boolean => (source[nome] ?? "").trim() !== "";
  return cheia("META_WEBHOOK_VERIFY_TOKEN") && cheia("META_APP_SECRET");
}

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [algo, received] = signatureHeader.split("=");
  if (algo !== "sha256" || !received) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  // timingSafeEqual estoura se os tamanhos diferem — comparar antes evita
  // transformar assinatura malformada em exceção 500.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

/** Resposta do handshake de verificação (GET). `null` = recusar com 403. */
export function verificationChallenge(
  params: URLSearchParams,
  expectedVerifyToken: string,
): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!expectedVerifyToken) return null;
  if (params.get("hub.verify_token") !== expectedVerifyToken) return null;
  return params.get("hub.challenge");
}

/** Um template mudou de estado na Meta — o evento que a Fase 3a persegue. */
export interface TemplateStatusEvent {
  kind: "template_status";
  wabaId: string;
  templateName: string;
  templateLanguage: string;
  event: string;
  reason: string | null;
}

/**
 * Mensagem ENVIADA PELO CONTATO. A metade que faltava do canal: sem ela o oficial
 * é um megafone — o cliente responde e nada chega, nenhum lead se move, o agente não
 * acorda, e a janela de 24h (que deriva de `last_inbound_at`) nunca abre.
 */
export interface InboundMessageEvent {
  kind: "inbound_message";
  wabaId: string;
  /** Qual número NOSSO recebeu — é o que amarra a mensagem à sessão certa. */
  phoneNumberId: string;
  /** `wamid` — a chave de idempotência. A Meta re-entrega o que não recebe 2xx. */
  externalId: string;
  /**
   * `wa_id` do contato. **Pode vir sem o nono dígito** em celular brasileiro
   * (medido: 553198966398 para quem recebemos como 5531998966398) — quem resolve o
   * contato TEM de usar `phoneLookupVariants`, senão duplica a pessoa.
   */
  from: string;
  profileName: string | null;
  sentAt: Date;
  /** `text` | `audio` | `image` | `video` | `document` | `sticker` | `contact` | … */
  type: string;
  text: string | null;
  /** Preenchido quando `type === "contact"` (cartão compartilhado). */
  sharedContact?: SharedContact | null;
  media: {
    id: string;
    /** A Meta manda URL pronta, com `ext=` de expiração — baixe na hora, não guarde. */
    url: string | null;
    mime: string | null;
    /** Nota de voz de verdade (não anexo de áudio). */
    voice: boolean;
  } | null;
  /**
   * `messages[].referral` cru — vem na mensagem que o app do cliente manda ao
   * clicar num anúncio "Clique para o WhatsApp". Repassado sem interpretar: a
   * leitura é de `extrairAtribuicaoMeta`. Opcional porque só a ingestão o lê.
   */
  referral?: unknown;
}

/** Status de entrega de uma mensagem que ENVIAMOS (sent/delivered/read/failed). */
export interface MessageStatusEvent {
  kind: "message_status";
  wabaId: string;
  /**
   * O número que enviou a mensagem, de `value.metadata.phone_number_id`. É por ele
   * que o endpoint universal descobre de quem é o status. Opcional: entrega sem
   * `metadata` continua sendo lida (e a rota por token não precisa dele).
   */
  phoneNumberId?: string;
  externalId: string;
  status: string;
  recipient: string | null;
  errorCode: number | null;
  errorTitle: string | null;
}

/**
 * Mensagem que a EMPRESA mandou pelo aplicativo WhatsApp Business, num número em
 * coexistência (campo `smb_message_echoes`). O número fica nos dois lugares ao
 * mesmo tempo: o cliente conversa pela Cloud API e o dono segue respondendo pelo
 * celular — e sem este eco a resposta do celular não aparece no CRM, nem cala a
 * IA, que continuaria respondendo por cima de quem está atendendo.
 *
 * A Meta só manda eco do que saiu PELO APP: o que o CRM envia pela Cloud API não
 * volta por aqui.
 */
export interface EchoMessageEvent {
  kind: "echo_message";
  wabaId: string;
  /** Qual número NOSSO enviou — `value.metadata.phone_number_id`. */
  phoneNumberId: string;
  /** `wamid` — a chave de idempotência, a mesma das recebidas. */
  externalId: string;
  /** `wa_id` do CLIENTE (destinatário). `from` é o próprio número da empresa. */
  to: string;
  sentAt: Date;
  type: string;
  text: string | null;
  sharedContact?: SharedContact | null;
  media: InboundMessageEvent["media"];
}

/**
 * Webhook de SINCRONIZAÇÃO do app WhatsApp Business (coexistência): `history`
 * (histórico de conversas, em pedaços, ou a recusa) e `smb_app_state_sync`
 * (agenda de contatos). Nesta fase o `value` segue BRUTO para ser guardado —
 * nenhum campo de dentro dele vira mensagem, conversa ou contato.
 *
 * ⚠️ O `history` também chega com `messages[]` (o id da mídia de um pedaço já
 * entregue). É por isso que ele NUNCA passa pelo ramo de mensagem recebida: lá
 * a condição é `field === "messages"`, e aqui é o campo que decide.
 */
export interface SyncPayloadEvent {
  kind: "sync_payload";
  campo: "history" | "smb_app_state_sync";
  wabaId: string;
  /** O número dono do payload — `value.metadata.phone_number_id`. */
  phoneNumberId: string;
  value: Record<string, unknown>;
}

export type MetaWebhookEvent =
  | TemplateStatusEvent
  | MessageStatusEvent
  | InboundMessageEvent
  | EchoMessageEvent
  | SyncPayloadEvent;

/**
 * O formato do fio mora em `./envelope.ts`, onde é um schema Zod — e o tipo
 * NASCE dele (`z.infer`). Aqui era um `interface` escrita à mão, que o
 * `JSON.parse ... as` da rota prometia sem nunca conferir.
 */
export type { MetaWebhookEnvelope } from "./envelope";

/**
 * A Meta manda `rejected_reason: "NONE"` em template APROVADO (medido contra a WABA
 * real). Guardar o literal faz a tela anunciar um motivo de recusa que não existe.
 *
 * Mora aqui, no módulo puro, porque tem DOIS escritores da mesma coluna — o sync e
 * este webhook. Na prova ao vivo o webhook gravou `"NONE"` enquanto o sync gravava
 * `null`: a mesma linha ficava com convenções diferentes dependendo de quem a
 * tocou por último. Regra duplicada é regra que diverge.
 */
export function normalizeRejectedReason(v: unknown): string | null {
  const s = typeof v === "string" && v.length > 0 ? v : null;
  return s === null || s.toUpperCase() === "NONE" ? null : s;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Extrai os eventos que nos interessam. **Evento desconhecido é IGNORADO, não erro** —
 * a Meta re-entrega tudo que não recebe 2xx, então devolver falha para um evento que
 * não nos interessa vira auto-DDoS: ela re-tenta o mesmo payload em backoff por horas.
 */
/**
 * O texto de uma RESPOSTA a botão, ou `null` quando a mensagem não é resposta.
 *
 * Três formatos que a Meta usa para "o contato tocou num botão":
 *
 *   - `type: "button"` — resposta rápida de MODELO aprovado:
 *     `{ button: { text, payload } }`. `text` é o rótulo do botão;
 *   - `type: "interactive"` + `button_reply` — botão de mensagem interativa:
 *     `{ interactive: { type: "button_reply", button_reply: { id, title } } }`;
 *   - `type: "interactive"` + `list_reply` — item de lista:
 *     `{ interactive: { type: "list_reply", list_reply: { id, title } } }`.
 *
 * O rótulo, e não o `payload`/`id`: é o que aparece na conversa para quem
 * atende, e é o que o fluxo casa com a saída do botão (`casarRespostaDeBotao`,
 * pelo rótulo). O `payload` de resposta rápida é, por padrão, o próprio texto.
 * Sem rótulo, cai para o identificador — melhor uma palavra técnica na conversa
 * do que a resposta sumir.
 */
export function textoDaResposta(tipo: string, raw: Record<string, unknown>): string | null {
  if (tipo === "button") {
    const b = (raw.button ?? {}) as Record<string, unknown>;
    return str(b.text) ?? str(b.payload);
  }
  if (tipo === "interactive") {
    const i = (raw.interactive ?? {}) as Record<string, unknown>;
    const sub = str(i.type);
    if (sub === "button_reply" || sub === "list_reply") {
      const r = (i[sub] ?? {}) as Record<string, unknown>;
      return str(r.title) ?? str(r.id);
    }
  }
  return null;
}

/** A Meta manda epoch em SEGUNDOS, string. Passar direto ao Date daria 1970. */
function instanteDaMeta(v: unknown): Date {
  return new Date(Number(str(v) ?? "0") * 1000);
}

/**
 * O CONTEÚDO de uma mensagem do WhatsApp — tipo, texto, cartão e mídia. É o
 * mesmo na mensagem recebida e no eco do app Business, e mora num lugar só para
 * as duas leituras não divergirem.
 */
function corpoDaMensagem(raw: Record<string, unknown>): {
  type: string;
  text: string | null;
  sharedContact: SharedContact | null;
  media: InboundMessageEvent["media"];
} {
  const tipo = str(raw.type) ?? "unknown";
  const resposta = textoDaResposta(tipo, raw);
  const corpoMidia =
    tipo !== "contacts" && resposta === null ? (raw[tipo] as Record<string, unknown> | undefined) : undefined;
  const sharedContact = tipo === "contacts" ? parseMetaInboundContact(raw) : null;
  // Resposta a botão chega como `button`/`interactive`, tipos que o CHECK
  // de `messages.type` não conhece — o INSERT falhava e o clique se
  // perdia. O que o contato disse é o RÓTULO que ele tocou: vira texto.
  const tipoCrm = tipo === "contacts" ? "contact" : resposta !== null ? "text" : tipo;
  return {
    type: tipoCrm,
    text:
      resposta !== null
        ? resposta
        : tipoCrm === "text"
          ? str((raw.text as Record<string, unknown>)?.body)
          : sharedContact?.name ?? null,
    sharedContact,
    media:
      corpoMidia && str(corpoMidia.id)
        ? {
            id: str(corpoMidia.id)!,
            url: str(corpoMidia.url),
            mime: str(corpoMidia.mime_type),
            voice: corpoMidia.voice === true,
          }
        : null,
  };
}

export function parseMetaWebhook(envelope: MetaWebhookEnvelope): MetaWebhookEvent[] {
  const out: MetaWebhookEvent[] = [];
  if (envelope?.object !== "whatsapp_business_account") {
    // A rota responde 200 com `received: 0`: sem esta linha, o descarte é mudo.
    logger.warn("[meta.webhook] entrega descartada: objeto não é whatsapp_business_account", {
      motivo: "objeto_inesperado",
      objeto: typeof envelope?.object === "string" ? envelope.object.slice(0, 64) : null,
    });
    return out;
  }

  for (const entry of envelope.entry ?? []) {
    const wabaId = str(entry.id) ?? "";
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};

      if (change.field === "message_template_status_update") {
        const name = str(v.message_template_name);
        const language = str(v.message_template_language);
        if (!name || !language) continue; // payload capenga não vira linha meia-boca
        out.push({
          kind: "template_status",
          wabaId,
          templateName: name,
          templateLanguage: language,
          event: str(v.event) ?? "UNKNOWN",
          reason: normalizeRejectedReason(v.reason),
        });
        continue;
      }

      // Mensagens RECEBIDAS. Vem no mesmo `field: "messages"` das entregas — o que
      // separa é `messages[]` (do contato) vs `statuses[]` (das nossas). Tratar os
      // dois no mesmo `if` faria um mascarar o outro quando ambos vêm juntos.
      if (change.field === "messages" && Array.isArray(v.messages)) {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        const contatos = Array.isArray(v.contacts) ? (v.contacts as Record<string, unknown>[]) : [];
        for (const raw of v.messages as Record<string, unknown>[]) {
          const id = str(raw.id);
          const from = str(raw.from);
          if (!id || !from) continue; // payload capenga não vira linha meia-boca

          const perfil = contatos.find((c) => str(c.wa_id) === from);
          const corpo = corpoDaMensagem(raw);

          out.push({
            kind: "inbound_message",
            wabaId,
            phoneNumberId: str(meta.phone_number_id) ?? "",
            externalId: id,
            from,
            profileName: str((perfil?.profile as Record<string, unknown> | undefined)?.name),
            sentAt: instanteDaMeta(raw.timestamp),
            type: corpo.type,
            text: corpo.text,
            ...(corpo.sharedContact ? { sharedContact: corpo.sharedContact } : {}),
            media: corpo.media,
            referral: raw.referral ?? null,
          });
        }
        continue;
      }

      // Eco do que a EMPRESA mandou pelo app WhatsApp Business (coexistência).
      // Campo próprio, então não esbarra em `messages`/`statuses` acima. Sem o
      // número que enviou, o eco não tem dono: fica de fora aqui mesmo, e a rota
      // nunca chega a procurar sessão para ele.
      if (change.field === "smb_message_echoes" && Array.isArray(v.message_echoes)) {
        const numero = str(((v.metadata ?? {}) as Record<string, unknown>).phone_number_id);
        if (!numero) continue;
        for (const raw of v.message_echoes as Record<string, unknown>[]) {
          const id = str(raw.id);
          const to = str(raw.to);
          if (!id || !to) continue; // payload capenga não vira linha meia-boca
          const corpo = corpoDaMensagem(raw);
          out.push({
            kind: "echo_message",
            wabaId,
            phoneNumberId: numero,
            externalId: id,
            to,
            sentAt: instanteDaMeta(raw.timestamp),
            type: corpo.type,
            text: corpo.text,
            ...(corpo.sharedContact ? { sharedContact: corpo.sharedContact } : {}),
            media: corpo.media,
          });
        }
        continue;
      }

      // Sincronização do app (coexistência): o `value` segue bruto. Sem o número
      // dono, o payload não tem a quem pertencer e fica de fora aqui mesmo.
      if (change.field === "history" || change.field === "smb_app_state_sync") {
        const numero = str(((v.metadata ?? {}) as Record<string, unknown>).phone_number_id);
        if (!numero) {
          logger.warn("[meta.webhook] sincronização descartada: sem phone_number_id", {
            motivo: "sem_phone_number_id",
            campo: change.field,
            waba_id: wabaId || null,
          });
          continue;
        }
        out.push({
          kind: "sync_payload",
          campo: change.field,
          wabaId,
          phoneNumberId: numero,
          value: v as Record<string, unknown>,
        });
        continue;
      }

      if (change.field === "messages" && Array.isArray(v.statuses)) {
        const numeroDoStatus = str(((v.metadata ?? {}) as Record<string, unknown>).phone_number_id);
        for (const raw of v.statuses as Record<string, unknown>[]) {
          const id = str(raw.id);
          if (!id) continue;
          const errors = Array.isArray(raw.errors)
            ? (raw.errors as Record<string, unknown>[])
            : [];
          const first = errors[0] ?? {};
          out.push({
            kind: "message_status",
            wabaId,
            ...(numeroDoStatus ? { phoneNumberId: numeroDoStatus } : {}),
            externalId: id,
            status: str(raw.status) ?? "unknown",
            recipient: str(raw.recipient_id),
            errorCode: typeof first.code === "number" ? first.code : null,
            errorTitle: str(first.title),
          });
        }
      }
      // Qualquer outro `field` cai fora de propósito — ver o comentário acima.
    }
  }
  return out;
}
