"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import {
  contarVariaveis,
  IDIOMAS_DA_DEFINICAO,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";

import { PreviaDaDefinicao } from "./PreviaDaDefinicao";

/** O que o formulário entrega: o rascunho pronto para a plataforma revisar. */
export interface RascunhoDaDefinicao {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

/**
 * O formulário de CRIAR uma definição aprovada, com a prévia ao lado.
 *
 * Um só para todos os canais que criam modelo — os parceiros e o oficial. Quem
 * usa decide o que muda entre eles: para onde o rascunho vai (`onEnviar`), o
 * idioma que já vem escolhido e se o cabeçalho de MÍDIA é oferecido (o canal
 * oficial ainda não o cria: a Meta exige o arquivo pelo upload dela). Campos
 * próprios de um canal — a conexão, no oficial — entram por `children`, no topo.
 *
 * Para recomeçar em branco depois de enviar, quem usa troca a `key`.
 */
export function FormularioDeDefinicao({
  onEnviar,
  enviando,
  podeEnviar = true,
  idiomaInicial = "es",
  permiteMidia = true,
  rotaDaMidia = "/api/v1/channels/partner/templates/media",
  children,
}: {
  onEnviar: (rascunho: RascunhoDaDefinicao) => void;
  enviando: boolean;
  /** Condição extra do canal para enviar (ex.: conexão escolhida). */
  podeEnviar?: boolean;
  idiomaInicial?: string;
  permiteMidia?: boolean;
  rotaDaMidia?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const [nome, setNome] = useState("");
  const [idioma, setIdioma] = useState(idiomaInicial);
  const [categoria, setCategoria] = useState("UTILITY");
  const [corpo, setCorpo] = useState("");
  const [rodape, setRodape] = useState("");
  const [exemplos, setExemplos] = useState<string[]>([]);
  const [cabecalho, setCabecalho] = useState("");
  const [midiaUrl, setMidiaUrl] = useState("");
  const [botoes, setBotoes] = useState<BotaoDaDefinicao[]>([]);
  const [subindo, setSubindo] = useState(false);

  // Quantas amostras a revisão vai exigir. Recalculado enquanto se digita: o
  // operador vê o campo aparecer no instante em que escreve `{{1}}`, e não
  // descobre a exigência numa recusa que chega horas depois.
  const nVariaveis = contarVariaveis(corpo);

  return (
    <div className="grid gap-4 rounded-md border border-border p-3 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-2">
      {children}
      <div className="flex flex-wrap gap-2">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="nome_do_modelo"
          aria-label={t("Nome do modelo")}
          className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
        />
        {/* LISTA, e não campo livre. O contrato descreve o formato e não
            enumera os valores; digitar é onde o erro nasce — `esp`, `ES`,
            `es-AR` e `español` são todos recusados, e a recusa volta como
            "language not supported" horas depois. */}
        <select
          value={idioma}
          onChange={(e) => setIdioma(e.target.value)}
          aria-label={t("Idioma")}
          className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm"
        >
          {IDIOMAS_DA_DEFINICAO.map((i) => (
            <option key={i.codigo} value={i.codigo}>
              {t(i.rotulo)} ({i.codigo})
            </option>
          ))}
        </select>
      </div>
      {/* A CATEGORIA é obrigatória no contrato e não era oferecida: tudo
          saía como UTILITY. Mandar promoção como utility é reclassificado
          (ou recusado) pela revisão — e a tarifa da categoria errada é mais
          cara. O padrão continua UTILITY porque é o caso comum de
          atendimento, mas agora é escolha. */}
      <select
        value={categoria}
        onChange={(e) => setCategoria(e.target.value)}
        aria-label={t("Categoria")}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="UTILITY">
          {t("Utilidade — aviso de pedido, agendamento, cobrança")}
        </option>
        <option value="MARKETING">{t("Marketing — promoção, novidade, reengajamento")}</option>
        <option value="AUTHENTICATION">{t("Autenticação — código de verificação")}</option>
      </select>

      {/* CABEÇALHO opcional: texto OU mídia, nunca os dois — a plataforma
          aceita um formato por definição, e mandar ambos é recusa. */}
      <div className="flex flex-wrap gap-2">
        <input
          value={cabecalho}
          onChange={(e) => {
            setCabecalho(e.target.value);
            if (e.target.value) setMidiaUrl("");
          }}
          placeholder={t("Cabeçalho de texto (opcional)")}
          aria-label={t("Cabeçalho de texto")}
          disabled={!!midiaUrl}
          className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
        />
        {permiteMidia && (
          <>
            {/* SUBIR, e não colar URL. Colar exigia que o operador já tivesse a
                  imagem hospedada em algum lugar público — que é justamente o que
                  ele não tem. O arquivo vai para o nosso storage e a rota devolve
                  um link assinado, que é o que a plataforma baixa na revisão. */}
            <label
              className={cn(
                "flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-2 text-sm text-muted-foreground hover:bg-muted",
                cabecalho && "pointer-events-none opacity-50",
              )}
            >
              {subindo
                ? t("Subindo…")
                : midiaUrl
                  ? t("Trocar imagem")
                  : t("Subir imagem (JPG/PNG)")}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                aria-label={t("Imagem do cabeçalho")}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setSubindo(true);
                  try {
                    const fd = new FormData();
                    fd.append("file", f);
                    const r = await fetch(rotaDaMidia, {
                      method: "POST",
                      body: fd,
                    });
                    const j = (await r.json()) as { data?: { url?: string }; error?: { message?: string } };
                    if (!r.ok || !j.data?.url) {
                      // A mensagem da rota CHEGA ao operador: é ela que
                      // distingue "formato" de "tamanho" de "erro nosso".
                      toast.error(t(j.error?.message ?? "Não consegui subir a imagem."));
                      return;
                    }
                    setMidiaUrl(j.data.url);
                    setCabecalho("");
                  } finally {
                    setSubindo(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <textarea
          value={corpo}
          onChange={(e) => setCorpo(e.target.value.slice(0, LIMITE_CORPO))}
          placeholder={t("Texto da mensagem. Use {{1}}, {{2}} para os valores que mudam.")}
          aria-label={t("Conteúdo")}
          className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
        {/* O contador existe porque passar do limite é RECUSA, e a recusa
            chega horas depois sem dizer que o problema era o tamanho. */}
        <span className="self-end text-[10px] text-muted-foreground">
          {corpo.length}/{LIMITE_CORPO}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <input
          value={rodape}
          onChange={(e) => setRodape(e.target.value.slice(0, LIMITE_RODAPE))}
          placeholder={t("Rodapé (opcional) — texto pequeno no fim da mensagem")}
          aria-label={t("Rodapé")}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        />
        <span className="self-end text-[10px] text-muted-foreground">
          {rodape.length}/{LIMITE_RODAPE}
        </span>
      </div>

      {/* BOTÕES: até três, e cada tipo pede um campo diferente. URL sem
          endereço e telefone sem número são recusados — por isso o campo
          extra aparece junto com o tipo, e não escondido atrás de outro
          clique. */}
      <div className="flex flex-col gap-1.5">
        {botoes.map((b, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={b.tipo}
              onChange={(e) => {
                const p = [...botoes];
                p[i] = { ...b, tipo: e.target.value as BotaoDaDefinicao["tipo"] };
                setBotoes(p);
              }}
              aria-label={`${t("Tipo do botão")} ${i + 1}`}
              className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="quick_reply">{t("Resposta rápida")}</option>
              <option value="url">{t("Abrir link")}</option>
              {/* NÃO usar t("Ligar") aqui: essa chave já existe no dicionário
                  traduzida como "Activar" (o toggle de automações em
                  RulesTab.tsx) — mesma palavra fonte, sentido diferente
                  ("Llamar", não "Activar"). Texto puro evita a tradução errada. */}
              <option value="phone_number">Ligar</option>
            </select>
            <input
              value={b.texto}
              onChange={(e) => {
                const p = [...botoes];
                p[i] = { ...b, texto: e.target.value };
                setBotoes(p);
              }}
              placeholder={t("Texto do botão")}
              aria-label={`${t("Texto do botão")} ${i + 1}`}
              className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            />
            {b.tipo === "url" && (
              <input
                value={b.url ?? ""}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, url: e.target.value };
                  setBotoes(p);
                }}
                placeholder="https://…"
                aria-label={`${t("URL do botão")} ${i + 1}`}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              />
            )}
            {b.tipo === "phone_number" && (
              <input
                value={b.telefone ?? ""}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, telefone: e.target.value };
                  setBotoes(p);
                }}
                placeholder="+595…"
                aria-label={`${t("Telefone do botão")} ${i + 1}`}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              />
            )}
            <button
              type="button"
              onClick={() => setBotoes(botoes.filter((_, j) => j !== i))}
              className="text-xs text-muted-foreground hover:text-destructive"
              aria-label={`${t("Remover botão")} ${i + 1}`}
            >
              {t("remover")}
            </button>
          </div>
        ))}
        {botoes.length < LIMITE_BOTOES && (
          <button
            type="button"
            onClick={() => setBotoes([...botoes, { tipo: "quick_reply", texto: "" }])}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            + {t("Adicionar botão")} ({botoes.length}/{LIMITE_BOTOES})
          </button>
        )}
      </div>

      {nVariaveis > 0 && (
        /* ESTE É O CAMPO QUE FALTAVA, e a causa das recusas.
           A revisão exige uma AMOSTRA de cada `{{n}}` — sem ela a definição
           é recusada, e a recusa chega horas depois sem ninguém ligar uma
           coisa à outra. O formulário deixava digitar `{{1}}` e nunca
           pedia o exemplo. */
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800/60 dark:bg-amber-950/20">
          <p className="text-[11px] text-amber-900 dark:text-amber-200">
            {t("A revisão exige um exemplo de cada valor. Sem eles o modelo é recusado.")}
          </p>
          {Array.from({ length: nVariaveis }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                {`{{${i + 1}}}`}
              </span>
              <input
                value={exemplos[i] ?? ""}
                onChange={(e) => {
                  const proximo = [...exemplos];
                  proximo[i] = e.target.value;
                  setExemplos(proximo);
                }}
                placeholder={t("ex.: María")}
                aria-label={`${t("Exemplo do valor")} ${i + 1}`}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              />
            </div>
          ))}
        </div>
      )}

      {/* O formato do nome e o texto são validados PELA PLATAFORMA, e a
          recusa dela chega inteira ao operador. Repetir a regra aqui a faria
          envelhecer separado da fonte. */}
      <p className="text-[11px] text-muted-foreground">
        {t(
          "A plataforma revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até ela decidir.",
        )}
      </p>
      <div className="flex sm:justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!nome.trim() || !corpo.trim() || enviando || !podeEnviar}
          onClick={() =>
            onEnviar({
              name: nome.trim(),
              language: idioma.trim(),
              category: categoria,
              components: montarComponents({
                body: corpo,
                footer: rodape,
                exemplos,
                cabecalho: { texto: cabecalho, midiaUrl },
                botoes,
              }),
            })
          }
          className="w-full sm:w-auto"
        >
          {t("Enviar para revisão")}
        </Button>
      </div>
      </div>

      {/* A prévia fica AO LADO, não embaixo: embaixo ela sai da tela junto
          com o botão de enviar, e o operador manda sem ter olhado. */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <PreviaDaDefinicao
          cabecalho={cabecalho}
          midiaUrl={midiaUrl}
          corpo={corpo}
          rodape={rodape}
          botoes={botoes}
        />
      </div>
    </div>
  );
}
