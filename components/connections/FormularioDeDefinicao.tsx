"use client";

import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useCamposDoContato } from "@/hooks/catalogo/useCatalogo";
import { useT } from "@/hooks/i18n/useT";
import {
  IDIOMAS_DA_DEFINICAO,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";
import { formatoDosTextos, lerVariaveis } from "@/lib/channels/template-variaveis";
import { cn } from "@/lib/utils";
import { CAMPOS_DO_SISTEMA } from "@/lib/variaveis/campos-do-sistema";

import { EditorComVariaveis, variaveisParaExemplo, type CategoriaDoSeletor } from "./EditorComVariaveis";
import { PreviaDaDefinicao } from "./PreviaDaDefinicao";

/** O que o formulário entrega: o rascunho pronto para a plataforma revisar. */
export interface RascunhoDaDefinicao {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

/**
 * Os valores com que o formulário ABRE — para editar uma definição que já
 * existe (ver `paraFormulario` em lib/channels/template-conteudo.ts). Lido só
 * na montagem: para trocar de definição, quem usa troca a `key`.
 */
export interface ValoresDaDefinicao {
  nome: string;
  idioma: string;
  categoria: string;
  cabecalho: string;
  midiaUrl: string;
  corpo: string;
  rodape: string;
  /** Por posição (forma antiga) — usado quando `exemplosPorNome` não vem. */
  exemplos: string[];
  /** Amostra de cada variável do corpo, pelo nome (`"1"` ou `"primeiro_nome"`). */
  exemplosPorNome?: Record<string, string>;
  /** Amostra da variável do cabeçalho de texto. */
  exemploCabecalho?: string;
  botoes: BotaoDaDefinicao[];
}

/** Os exemplos de abertura, por nome — da forma nova ou da antiga (por posição). */
function exemplosIniciais(inicial?: ValoresDaDefinicao): Record<string, string> {
  if (!inicial) return {};
  if (inicial.exemplosPorNome && Object.keys(inicial.exemplosPorNome).length > 0) return { ...inicial.exemplosPorNome };
  const out: Record<string, string> = {};
  lerVariaveis(inicial.corpo).variaveis.forEach((v, i) => {
    out[v.nome] = inicial.exemplos[i] ?? "";
  });
  return out;
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
 *
 * EDITAR reusa este mesmo formulário, aberto com `inicial` e com `editando`:
 * nome, idioma e categoria ficam travados, porque a plataforma não deixa
 * mudá-los depois de criado — oferecer o campo seria prometer uma edição que
 * ela recusa.
 */
export function FormularioDeDefinicao({
  onEnviar,
  enviando,
  podeEnviar = true,
  idiomaInicial = "es",
  permiteMidia = true,
  rotaDaMidia = "/api/v1/channels/partner/templates/media",
  inicial,
  editando = false,
  children,
}: {
  onEnviar: (rascunho: RascunhoDaDefinicao) => void;
  enviando: boolean;
  /** Condição extra do canal para enviar (ex.: conexão escolhida). */
  podeEnviar?: boolean;
  idiomaInicial?: string;
  permiteMidia?: boolean;
  rotaDaMidia?: string;
  /** Valores de abertura (edição). Ausente = formulário em branco. */
  inicial?: ValoresDaDefinicao;
  /** Edição de uma definição existente: trava nome, idioma e categoria. */
  editando?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const [nome, setNome] = useState(inicial?.nome ?? "");
  const [idioma, setIdioma] = useState(inicial?.idioma ?? idiomaInicial);
  const [categoria, setCategoria] = useState(inicial?.categoria ?? "UTILITY");
  const [corpo, setCorpo] = useState(inicial?.corpo ?? "");
  const [rodape, setRodape] = useState(inicial?.rodape ?? "");
  const [exemplos, setExemplos] = useState<Record<string, string>>(() => exemplosIniciais(inicial));
  const [exemploCabecalho, setExemploCabecalho] = useState(inicial?.exemploCabecalho ?? "");
  const [cabecalho, setCabecalho] = useState(inicial?.cabecalho ?? "");
  const [midiaUrl, setMidiaUrl] = useState(inicial?.midiaUrl ?? "");
  const [botoes, setBotoes] = useState<BotaoDaDefinicao[]>(inicial?.botoes ?? []);
  const [subindo, setSubindo] = useState(false);

  // As categorias do seletor de variáveis. "Campos do sistema" é a lista única
  // (`lib/variaveis/campos-do-sistema.ts`); "Campos do usuário" é o registro da
  // organização, pela chave — que já nasce no formato que a Meta aceita.
  const { data: camposDoUsuario = [] } = useCamposDoContato();
  const categorias = useMemo<CategoriaDoSeletor[]>(
    () => [
      {
        id: "sistema",
        rotulo: t("Campos do sistema"),
        campos: CAMPOS_DO_SISTEMA.map((c) => ({ chave: c.chave, rotulo: t(c.rotulo), icone: c.icone })),
      },
      {
        id: "usuario",
        rotulo: t("Campos personalizados do usuário"),
        campos: camposDoUsuario.map((c) => ({
          chave: c.key,
          rotulo: c.label,
          icone: c.type === "number" ? ("numero" as const) : c.type === "email" ? ("email" as const) : ("texto" as const),
        })),
        vazio: t("Nenhum campo cadastrado. Crie em Configurações › Campos do Usuário."),
      },
    ],
    [camposDoUsuario, t],
  );

  // As variáveis, recalculadas enquanto se digita: o campo de exemplo aparece
  // no instante em que a variável entra e some quando ela sai — e a ordem é a
  // do texto. A régua é a única do produto (`template-variaveis.ts`).
  const doCorpo = variaveisParaExemplo(corpo, categorias);
  const doCabecalho = midiaUrl ? [] : variaveisParaExemplo(cabecalho, categorias);
  const invalidas = [...lerVariaveis(cabecalho).invalidas, ...lerVariaveis(corpo).invalidas];
  const formato = formatoDosTextos([corpo, midiaUrl ? null : cabecalho]);
  const faltaExemplo =
    doCorpo.some((v) => !exemplos[v.nome]?.trim()) || (doCabecalho.length > 0 && !exemploCabecalho.trim());
  const problema =
    invalidas.length > 0
      ? `${invalidas[0]} ${t("não é uma variável válida. Use {{1}}, {{2}}… ou um nome com letras minúsculas, números e _ (ex.: {{primeiro_nome}}).")}`
      : formato === "MISTO"
        ? t("Use só valores numerados ({{1}}, {{2}}…) ou só nomes ({{primeiro_nome}}) — a Meta não aceita os dois no mesmo modelo.")
        : doCabecalho.length > 1
          ? t("O cabeçalho aceita no máximo uma variável.")
          : lerVariaveis(rodape).variaveis.length > 0
            ? t("O rodapé não aceita variáveis.")
            : null;

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
          disabled={editando}
          className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
        />
        {/* LISTA, e não campo livre. O contrato descreve o formato e não
            enumera os valores; digitar é onde o erro nasce — `esp`, `ES`,
            `es-AR` e `español` são todos recusados, e a recusa volta como
            "language not supported" horas depois. */}
        <select
          value={idioma}
          onChange={(e) => setIdioma(e.target.value)}
          aria-label={t("Idioma")}
          disabled={editando}
          className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
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
        disabled={editando}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
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
        <div className={cn("min-w-0 flex-1", midiaUrl && "pointer-events-none opacity-50")}>
          <EditorComVariaveis
            valor={cabecalho}
            aoMudar={(v) => {
              setCabecalho(v);
              if (v) setMidiaUrl("");
            }}
            categorias={categorias}
            umaLinha
            limite={60}
            placeholder={t("Cabeçalho de texto (opcional)")}
            rotuloAcessivel={t("Cabeçalho de texto")}
            testId="modelo-cabecalho"
          />
        </div>
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
        <EditorComVariaveis
          valor={corpo}
          aoMudar={setCorpo}
          categorias={categorias}
          limite={LIMITE_CORPO}
          invalido={!!problema || faltaExemplo}
          placeholder={t("Texto da mensagem. Digite {{ para inserir uma variável.")}
          rotuloAcessivel={t("Conteúdo")}
          testId="modelo-corpo"
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

      {problema && (
        <p className="text-[11px] text-destructive" role="alert" data-testid="modelo-problema">
          {problema}
        </p>
      )}

      {(doCorpo.length > 0 || doCabecalho.length > 0) && (
        /* AS AMOSTRAS — uma por variável, na ordem do texto.
           A revisão exige um exemplo de cada variável; sem ele o modelo é
           recusado horas depois. O exemplo é SÓ para a revisão: o valor que o
           contato recebe é definido no fluxo ou no disparo. */
        <div
          className="flex flex-col gap-1.5 rounded-md border border-sky-300 bg-sky-50/60 p-2 dark:border-sky-800/60 dark:bg-sky-950/20"
          data-testid="modelo-amostras"
        >
          <p className="text-xs font-medium text-sky-950 dark:text-sky-100">{t("Forneça amostras de suas variáveis")}</p>
          <p className="text-[11px] text-sky-900 dark:text-sky-200">
            {t(
              "A Meta usa estes exemplos só para aprovar o modelo (ex.: Nome → João). O valor que cada contato recebe é definido depois, no fluxo ou no disparo.",
            )}
          </p>
          {doCabecalho.map((v) => (
            <LinhaDeAmostra
              key={`cab-${v.nome}`}
              rotulo={`${v.rotulo} · ${t("cabeçalho")}`}
              valor={exemploCabecalho}
              aoMudar={setExemploCabecalho}
              rotuloAcessivel={`${t("Exemplo da variável")} ${v.nome} (${t("cabeçalho")})`}
            />
          ))}
          {doCorpo.map((v) => (
            <LinhaDeAmostra
              key={v.nome}
              rotulo={v.rotulo}
              valor={exemplos[v.nome] ?? ""}
              aoMudar={(valor) => setExemplos((e) => ({ ...e, [v.nome]: valor }))}
              rotuloAcessivel={`${t("Exemplo da variável")} ${v.nome}`}
            />
          ))}
        </div>
      )}

      {/* O formato do nome e o texto são validados PELA PLATAFORMA, e a
          recusa dela chega inteira ao operador. Repetir a regra aqui a faria
          envelhecer separado da fonte. */}
      <p className="text-[11px] text-muted-foreground">
        {editando
          ? t(
              "Ao salvar, a plataforma revisa o modelo de novo. A Meta limita quantas vezes um modelo aprovado pode ser editado; se passar do limite, a resposta dela aparece aqui.",
            )
          : t(
              "A plataforma revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até ela decidir.",
            )}
      </p>
      <div className="flex sm:justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!nome.trim() || !corpo.trim() || enviando || !podeEnviar || !!problema || faltaExemplo}
          title={faltaExemplo ? t("Preencha o exemplo de cada variável.") : undefined}
          onClick={() =>
            onEnviar({
              name: nome.trim(),
              language: idioma.trim(),
              category: categoria,
              components: montarComponents({
                body: corpo,
                footer: rodape,
                exemplos,
                exemploCabecalho,
                cabecalho: { texto: cabecalho, midiaUrl },
                botoes,
              }),
            })
          }
          className="w-full sm:w-auto"
        >
          {editando ? t("Salvar e enviar para revisão") : t("Enviar para revisão")}
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
          exemplos={exemplos}
          exemploCabecalho={exemploCabecalho}
        />
      </div>
    </div>
  );
}

/** Uma variável → o exemplo dela. Vazio fica marcado: sem ele, a Meta recusa. */
function LinhaDeAmostra({
  rotulo,
  valor,
  aoMudar,
  rotuloAcessivel,
}: {
  rotulo: string;
  valor: string;
  aoMudar: (v: string) => void;
  rotuloAcessivel: string;
}) {
  const t = useT();
  const vazio = !valor.trim();
  return (
    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
      <span className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-input bg-muted/60 px-2 text-sm sm:max-w-[45%]">
        {rotulo}
      </span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <input
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
        placeholder={t("ex.: João")}
        aria-label={rotuloAcessivel}
        aria-invalid={vazio || undefined}
        className={cn(
          "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm",
          vazio ? "border-destructive" : "border-input",
        )}
      />
    </div>
  );
}
