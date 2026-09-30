"use client";
import Image from "next/image";

import { contarVariaveis, type BotaoDaDefinicao } from "@/lib/channels/template-conteudo";
import { lerVariaveis } from "@/lib/channels/template-variaveis";
import { ArrowBendUpLeft, ArrowSquareOut, Checks, Phone } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * Como a mensagem vai chegar ao cliente.
 *
 * ─── Por que uma prévia, e não só os campos ────────────────────────────────
 *
 * O formulário mostra pedaços — cabeçalho aqui, corpo ali, botões embaixo — e a
 * mensagem chega inteira. Erros que só aparecem no conjunto (rodapé repetindo o
 * que o corpo já disse, `{{2}}` sem `{{1}}`, botão com texto que não cabe) não
 * se enxergam campo a campo.
 *
 * E há um custo real em errar: cada definição vai para revisão da plataforma e
 * volta horas depois. Ver antes é o que evita o ciclo.
 *
 * ─── As variáveis aparecem COMO VARIÁVEIS ──────────────────────────────────
 *
 * `{{1}}` fica visível, não substituído pelo exemplo. Substituir mostraria uma
 * mensagem que nunca vai existir — o valor real muda a cada envio, e o que o
 * operador precisa conferir aqui é ONDE o buraco está, não como fica preenchido.
 */
export function PreviaDaDefinicao({
  cabecalho,
  midiaUrl,
  corpo,
  rodape,
  botoes,
  exemplos = {},
  exemploCabecalho = "",
}: {
  cabecalho: string;
  midiaUrl: string;
  corpo: string;
  rodape: string;
  botoes: BotaoDaDefinicao[];
  /** Amostras por nome — viram a dica de cada variável destacada. */
  exemplos?: Record<string, string>;
  exemploCabecalho?: string;
}) {
  const t = useT();
  const vazia = !cabecalho && !midiaUrl && !corpo && !rodape && botoes.length === 0;
  // `{{3}}` sem `{{1}}` é recusado — a numeração é posicional e a lista de
  // valores não pode ter buraco. Avisar aqui poupa o ciclo de revisão. Só vale
  // para o formato POSICIONAL: nomes (`{{primeiro_nome}}`) não têm ordem.
  const soPosicional = lerVariaveis(corpo).variaveis.every((v) => v.posicional);
  const buracos = corpo && soPosicional ? contarVariaveis(corpo) : 0;
  const faltando = Array.from({ length: buracos }, (_, i) => i + 1).filter(
    (n) => !new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`).test(corpo),
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t("Como o cliente vai ver")}</p>

      <div className="rounded-lg bg-muted/60 p-3">
        {vazia ? (
          <p className="text-xs italic text-muted-foreground">
            {t("Preencha o texto para ver a prévia.")}
          </p>
        ) : (
          // COMO NO WHATSAPP: balão com a hora, e os botões FORA do balão, cada
          // um no seu bloco com o ícone do tipo — é assim que o cliente vê, e é
          // assim que a plataforma do provedor mostra a prévia.
          <div className="max-w-[22rem]" data-previa-do-modelo>
            <div className="rounded-lg rounded-tl-none bg-background p-2.5 shadow-sm">
              {midiaUrl && (
                // `unoptimized`: a URL é assinada e temporária, e o otimizador do
                // Next a buscaria de novo depois de ela expirar.
                <Image
                  src={midiaUrl}
                  alt={t("Cabeçalho")}
                  width={320}
                  height={180}
                  unoptimized
                  className="mb-2 h-auto w-full rounded-md"
                />
              )}
              {cabecalho && (
                <p className="mb-1 text-sm font-semibold">
                  <ComVariaveis texto={cabecalho} exemplos={{}} exemploUnico={exemploCabecalho} />
                </p>
              )}
              {corpo && (
                <p className="whitespace-pre-wrap text-sm leading-snug">
                  <ComVariaveis texto={corpo} exemplos={exemplos} />
                </p>
              )}
              {rodape && <p className="mt-1 text-[11px] text-muted-foreground">{rodape}</p>}
              <p className="mt-1 flex items-center justify-end gap-0.5 text-[10px] text-muted-foreground">
                12:00 <Checks size={12} aria-hidden />
              </p>
            </div>

            {botoes.filter((b) => b.texto.trim()).length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {botoes
                  .filter((b) => b.texto.trim())
                  .map((b, i) => {
                    const Icone = b.tipo === "url" ? ArrowSquareOut : b.tipo === "phone_number" ? Phone : ArrowBendUpLeft;
                    return (
                      <span
                        key={i}
                        className="flex items-center justify-center gap-1.5 rounded-lg bg-background py-2 text-sm font-medium text-primary shadow-sm"
                      >
                        <Icone size={14} aria-hidden />
                        {b.texto}
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {faltando.length > 0 && (
        <p className="text-[11px] text-destructive">
          {t("Falta")} {faltando.map((n) => `{{${n}}}`).join(", ")} {t("no texto.")}{" "}
          {t("A numeração é sequencial e a plataforma recusa quando há buraco.")}
        </p>
      )}
    </div>
  );
}

/**
 * O texto com cada variável DESTACADA (o buraco continua visível — é ele que o
 * operador confere) e o exemplo na dica, para ver o que a revisão vai ler.
 */
function ComVariaveis({
  texto,
  exemplos,
  exemploUnico,
}: {
  texto: string;
  exemplos: Record<string, string>;
  exemploUnico?: string;
}) {
  const partes: Array<string | { nome: string }> = [];
  let ultimo = 0;
  for (const m of texto.matchAll(/\{\{\s*([a-z][a-z0-9_]*|\d+)\s*\}\}/g)) {
    const at = m.index ?? 0;
    if (at > ultimo) partes.push(texto.slice(ultimo, at));
    partes.push({ nome: m[1]! });
    ultimo = at + m[0].length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return (
    <>
      {partes.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <span
            key={i}
            title={(exemploUnico ?? exemplos[p.nome]) || undefined}
            className="rounded-sm bg-accent-500/15 px-0.5 font-mono text-[12px] text-accent-700 dark:text-accent-300"
          >
            {`{{${p.nome}}}`}
          </span>
        ),
      )}
    </>
  );
}
