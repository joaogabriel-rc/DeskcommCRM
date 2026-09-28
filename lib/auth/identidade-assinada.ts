/**
 * A identidade que o `proxy.ts` JÁ validou, entregue ao handler da MESMA
 * requisição sem uma segunda ida ao GoTrue.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * Medido em produção (VPS na Alemanha, Supabase em Oregon, ~250 ms por ida e
 * volta): `GET /api/v1/tags/cores` fazia TRÊS `GET /auth/v1/user` para o mesmo
 * JWT — o do proxy, o de `loadAuthUser` e o escondido em `mfa.listFactors()`,
 * que chama `getUser()` por dentro. Cada um é uma ida a Oregon que responde
 * exatamente o que a anterior acabou de responder.
 *
 * ── O que isto NÃO muda ─────────────────────────────────────────────────────
 *
 * Continua havendo UM `getUser()` por requisição — o do proxy —, e é ele que
 * decide. Nada aqui troca `getUser()` por `getSession()`/`getClaims()`: o JWT
 * segue revalidado no GoTrue a cada requisição, só não TRÊS vezes.
 *
 * ── Por que o cliente não consegue forjar ───────────────────────────────────
 *
 *  1. O proxy APAGA o cabeçalho que vier do navegador, antes de qualquer ramo.
 *  2. O valor é assinado com HMAC-SHA256 sob uma chave derivada da service role
 *     key — segredo que só o servidor tem. Sem ela não há assinatura válida.
 *  3. Vale por `VALIDADE_MS` e é AMARRADO ao hash dos cookies de sessão que o
 *     proxy validou. Se o handler enxergar outros cookies (login, troca de
 *     sessão, MFA verificado no meio da requisição), a amarra não bate e o
 *     handler faz o `getUser()` de sempre.
 *  4. Qualquer falha de verificação vira `null` — e `null` quer dizer
 *     "pergunte ao GoTrue", nunca "anônimo" nem "autorizado".
 *
 * Runtime-agnóstico (WebCrypto): o mesmo arquivo roda no proxy e no handler.
 */
import type { User } from "@supabase/supabase-js";

/** Cabeçalho INTERNO: só o proxy escreve, o navegador nunca o vê. */
export const CABECALHO_IDENTIDADE = "x-identidade-verificada";

/** Uma requisição inteira, com folga; depois disso, volta a perguntar ao GoTrue. */
export const VALIDADE_MS = 60_000;

/** Usuário com metadata enorme não viaja em cabeçalho: cai no caminho de sempre. */
const TAMANHO_MAXIMO = 12_000;

const ROTULO_DA_CHAVE = "identidade-da-requisicao:v1:";

interface Carga {
  /** id do usuário — redundante com `u.id` de propósito, conferido na volta. */
  uid: string;
  /** o `User` que o GoTrue devolveu ao proxy. */
  u: User;
  /** emitido em (ms). */
  iat: number;
  /** sha256 dos cookies de sessão que o proxy validou. */
  b: string;
}

type CookieSimples = { name: string; value: string };

/**
 * Os cookies desta requisição e o NOME do cookie de sessão. O nome vem de quem o
 * declara (`proxy.ts`, `lib/supabase/server.ts`) — não é repetido aqui.
 */
export interface CookiesDaSessao {
  nome: string;
  todos: CookieSimples[];
}

const enc = new TextEncoder();
const chaves = new Map<string, Promise<CryptoKey>>();

function chaveHmac(segredo: string): Promise<CryptoKey> {
  let chave = chaves.get(segredo);
  if (!chave) {
    chave = crypto.subtle.importKey(
      "raw",
      enc.encode(ROTULO_DA_CHAVE + segredo),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    chaves.set(segredo, chave);
  }
  return chave;
}

function paraBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deBase64Url(texto: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) return null;
  const b64 = texto.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Hash dos cookies de SESSÃO (inclusive os pedaços `.0`, `.1` do `@supabase/ssr`),
 * em ordem de nome. `null` quando não há sessão nenhuma — sem sessão, nada a amarrar.
 */
export async function vinculoDosCookies(cookies: CookiesDaSessao): Promise<string | null> {
  if (!cookies.nome) return null;
  const daSessao = cookies.todos
    .filter((c) => c.name.startsWith(cookies.nome) && c.value !== "")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (daSessao.length === 0) return null;
  const texto = daSessao.map((c) => `${c.name}=${c.value}`).join("\n");
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(texto));
  return paraBase64Url(new Uint8Array(hash));
}

/** Emite a identidade para o handler. `null` = não encaminhar (o handler pergunta ao GoTrue). */
export async function assinarIdentidade(
  user: User,
  cookies: CookiesDaSessao,
  segredo: string,
  agora: number = Date.now(),
): Promise<string | null> {
  if (!segredo || !user?.id) return null;
  const b = await vinculoDosCookies(cookies);
  if (!b) return null;
  const carga: Carga = { uid: user.id, u: user, iat: agora, b };
  const corpo = paraBase64Url(enc.encode(JSON.stringify(carga)));
  if (corpo.length > TAMANHO_MAXIMO) return null;
  const assinatura = await crypto.subtle.sign("HMAC", await chaveHmac(segredo), enc.encode(corpo));
  return `v1.${corpo}.${paraBase64Url(new Uint8Array(assinatura))}`;
}

/**
 * Devolve o `User` que o proxy validou — ou `null` se qualquer coisa não bater:
 * formato, assinatura, validade, amarra com os cookies atuais, ou coerência do id.
 */
export async function verificarIdentidade(
  valor: string | null | undefined,
  cookies: CookiesDaSessao,
  segredo: string,
  agora: number = Date.now(),
): Promise<User | null> {
  if (!valor || !segredo || valor.length > TAMANHO_MAXIMO + 200) return null;
  const partes = valor.split(".");
  if (partes.length !== 3 || partes[0] !== "v1") return null;
  const [, corpo, assinaturaB64] = partes as [string, string, string];
  const assinatura = deBase64Url(assinaturaB64);
  if (!assinatura) return null;

  // `verify` compara em tempo constante; nunca comparar a string da assinatura.
  const valida = await crypto.subtle.verify(
    "HMAC",
    await chaveHmac(segredo),
    assinatura,
    enc.encode(corpo),
  );
  if (!valida) return null;

  let carga: Carga;
  try {
    const bytes = deBase64Url(corpo);
    if (!bytes) return null;
    carga = JSON.parse(new TextDecoder().decode(bytes)) as Carga;
  } catch {
    return null;
  }
  if (typeof carga?.iat !== "number" || typeof carga.uid !== "string") return null;
  if (!carga.u || carga.u.id !== carga.uid) return null;
  // Emitida no futuro (relógio) ou vencida: não confia.
  if (carga.iat > agora + 5_000 || agora - carga.iat > VALIDADE_MS) return null;

  const b = await vinculoDosCookies(cookies);
  if (!b || b !== carga.b) return null;

  return carga.u;
}
