"use client";

import type { ModeloDoCatalogo } from "@/lib/channels/catalogo-de-modelos";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";

/**
 * Como o modelo escolhido vai chegar ao contato — montado a partir do CATÁLOGO
 * (`components` que a plataforma aprovou), nunca de texto guardado no nó. O nó
 * guarda a referência; o conteúdo é sempre o de agora.
 *
 * Os espaços aparecem COMO espaços (`{{1}}` destacado), não substituídos: o valor
 * muda a cada contato, e o que se confere aqui é onde cada buraco está.
 */
export function PreviaDoModelo({
  modelo,
  compacta = false,
}: {
  modelo: ModeloDoCatalogo;
  /** Versão do card do canvas: corpo cortado, sem rodapé longo. */
  compacta?: boolean;
}) {
  const t = useT();
  const { header, body, footer, botoes } = modelo.conteudo;
  const cabecalhoDeMidia = header && header.formato !== "TEXT";

  return (
    <div className={cn("rounded-md bg-surface-elevated p-2", compacta ? "text-xs" : "text-sm")}>
      {cabecalhoDeMidia && (
        <p className="mb-1 rounded-md bg-surface px-2 py-1 text-xs text-text-muted">
          {t("Cabeçalho")}: {rotuloDoFormato(header.formato, t)}
        </p>
      )}
      {header?.texto && <p className="mb-1 font-semibold">{comEspacos(header.texto)}</p>}
      {body && (
        <p className={cn("whitespace-pre-wrap break-words leading-snug", compacta && "line-clamp-4")}>
          {comEspacos(body)}
        </p>
      )}
      {footer && !compacta && <p className="mt-1 text-[11px] text-text-muted">{footer}</p>}
      {botoes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-1.5">
          {botoes.map((b, i) => (
            <li key={i} className="text-center text-xs font-medium text-accent">
              {b.texto || rotuloDoBotao(b.tipo, t)}
              {b.tipo !== "QUICK_REPLY" && !compacta && (
                <span className="ml-1 font-normal text-text-muted">({rotuloDoBotao(b.tipo, t)})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function rotuloDoFormato(formato: string, t: (s: string) => string): string {
  if (formato === "IMAGE") return t("imagem");
  if (formato === "VIDEO") return t("vídeo");
  if (formato === "DOCUMENT") return t("documento");
  if (formato === "LOCATION") return t("localização");
  return formato.toLowerCase();
}

function rotuloDoBotao(tipo: string, t: (s: string) => string): string {
  if (tipo === "QUICK_REPLY") return t("resposta rápida");
  if (tipo === "URL") return t("abre um link");
  if (tipo === "PHONE_NUMBER") return t("liga para um número");
  if (tipo === "COPY_CODE") return t("copia um código");
  return tipo.toLowerCase();
}

/** O texto com cada `{{n}}` destacado — mesma marcação da tela de Conexões. */
function comEspacos(texto: string) {
  return texto.split(/(\{\{\w+\}\})/g).map((parte, i) =>
    /^\{\{\w+\}\}$/.test(parte) ? (
      <span key={i} className="rounded-md bg-accent-soft px-1 font-mono text-[0.85em] text-accent">
        {parte}
      </span>
    ) : (
      <span key={i}>{parte}</span>
    ),
  );
}
