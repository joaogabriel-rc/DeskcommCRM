"use client";

/**
 * O campo de texto de um MODELO com variáveis que se enxergam.
 *
 * ─── Por que não um textarea ────────────────────────────────────────────────
 *
 * No textarea, `{{VAR1}}` era texto como outro qualquer: não havia sinal de
 * que aquilo era (ou não era) uma variável, e o modelo foi para a Meta com um
 * marcador que o CRM não contava. Aqui a variável vira uma PÍLULA — um token
 * que se apaga inteiro, não se edita por dentro e mostra o nome do campo.
 *
 * ─── Como se insere ─────────────────────────────────────────────────────────
 *
 *   - digitando `{{`: abre o seletor em duas colunas (categoria → campo),
 *     filtrado pelo que se digita depois das chaves;
 *   - pelo botão `{}` no canto do campo, que abre o mesmo seletor no cursor;
 *   - digitando `{{nome}}` inteiro, com nome válido: vira pílula ao fechar.
 *
 * O VALOR continua sendo texto com `{{nome}}` — é o que a Meta recebe e o que o
 * resto do produto lê (`lib/channels/template-variaveis.ts`). A pílula é só a
 * forma de mostrar.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { lerVariaveis } from "@/lib/channels/template-variaveis";
import { cn } from "@/lib/utils";
import { BracketsCurly, EnvelopeSimple, Hash, Phone, TextT } from "@/lib/ui/icons";

export interface CampoDoSeletor {
  /** Nome da variável no modelo — `primeiro_nome`, `cpf`… */
  chave: string;
  rotulo: string;
  icone?: "texto" | "email" | "telefone" | "numero";
}

export interface CategoriaDoSeletor {
  id: string;
  rotulo: string;
  campos: CampoDoSeletor[];
  /** Mostrado quando a categoria não tem campo. */
  vazio?: string;
}

const NOME_VALIDO = /^[a-z][a-z0-9_]*$/;
const POSICIONAL = /^\d+$/;
/** Um marcador COMPLETO e válido dentro de um trecho de texto. */
const MARCADOR_COMPLETO = /\{\{\s*([a-z][a-z0-9_]*|\d+)\s*\}\}/;

function Icone({ tipo }: { tipo?: CampoDoSeletor["icone"] }) {
  const props = { size: 14, "aria-hidden": true as const, className: "shrink-0 text-muted-foreground" };
  if (tipo === "email") return <EnvelopeSimple {...props} />;
  if (tipo === "telefone") return <Phone {...props} />;
  if (tipo === "numero") return <Hash {...props} />;
  return <TextT {...props} />;
}

// ── DOM ⇄ texto ────────────────────────────────────────────────────────────

function criarPilula(nome: string, rotulo: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.dataset.var = nome;
  s.contentEditable = "false";
  s.className =
    "mx-0.5 inline-flex select-none items-center rounded bg-accent-600 px-1.5 py-px align-baseline text-xs font-medium text-white";
  s.textContent = rotulo;
  return s;
}

/** O texto que o DOM representa (pílula → `{{nome}}`). */
function serializar(raiz: Node): string {
  let out = "";
  raiz.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    else if (n instanceof HTMLElement) {
      if (n.dataset.var) out += `{{${n.dataset.var}}}`;
      else if (n.tagName === "BR") out += "\n";
      else {
        // Navegador que embrulha a linha nova num <div>: vira quebra de linha.
        if (n.tagName === "DIV" && out && !out.endsWith("\n")) out += "\n";
        out += serializar(n);
      }
    }
  });
  return out;
}

/** Monta o DOM do texto: cada `{{nome}}` válido vira pílula. */
function renderizar(raiz: HTMLElement, texto: string, rotuloDe: (nome: string) => string) {
  raiz.replaceChildren();
  const re = /\{\{\s*([a-z][a-z0-9_]*|\d+)\s*\}\}/g;
  let ultimo = 0;
  for (const m of texto.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > ultimo) raiz.appendChild(document.createTextNode(texto.slice(ultimo, at)));
    raiz.appendChild(criarPilula(m[1]!, rotuloDe(m[1]!)));
    ultimo = at + m[0].length;
  }
  if (ultimo < texto.length) raiz.appendChild(document.createTextNode(texto.slice(ultimo)));
}

/** Posição do cursor no TEXTO serializado. */
function offsetDoCursor(raiz: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!raiz.contains(r.endContainer)) return null;
  const antes = document.createRange();
  antes.selectNodeContents(raiz);
  antes.setEnd(r.endContainer, r.endOffset);
  const frag = antes.cloneContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag);
  return serializar(tmp).length;
}

/** Põe o cursor na posição `alvo` do texto serializado. */
function colocarCursor(raiz: HTMLElement, alvo: number) {
  let resto = alvo;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  for (const n of Array.from(raiz.childNodes)) {
    const tam = n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "").length : serializar(wrap(n)).length;
    if (resto <= tam) {
      if (n.nodeType === Node.TEXT_NODE) range.setStart(n, resto);
      else range.setStartAfter(n);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    resto -= tam;
  }
  range.selectNodeContents(raiz);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function wrap(n: Node): HTMLElement {
  const d = document.createElement("div");
  d.appendChild(n.cloneNode(true));
  return d;
}

// ── Componente ─────────────────────────────────────────────────────────────

export function EditorComVariaveis({
  valor,
  aoMudar,
  categorias,
  placeholder,
  rotuloAcessivel,
  limite,
  umaLinha = false,
  invalido = false,
  testId,
}: {
  valor: string;
  aoMudar: (texto: string) => void;
  categorias: CategoriaDoSeletor[];
  placeholder?: string;
  rotuloAcessivel: string;
  limite?: number;
  umaLinha?: boolean;
  invalido?: boolean;
  testId?: string;
}) {
  const t = useT();
  const raiz = useRef<HTMLDivElement>(null);
  const caixa = useRef<HTMLDivElement>(null);
  /** O último texto que ESTE componente emitiu — distingue eco de mudança externa. */
  const emitido = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ consulta: string; x: number; y: number; pelaTecla: boolean } | null>(null);
  const [categoriaAtiva, setCategoriaAtiva] = useState(categorias[0]?.id ?? "");
  const [indice, setIndice] = useState(0);

  const rotulos = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categorias) for (const f of c.campos) if (!m.has(f.chave)) m.set(f.chave, f.rotulo);
    return m;
  }, [categorias]);
  const rotuloDe = useCallback((nome: string) => rotulos.get(nome) ?? nome, [rotulos]);

  // Valor externo → DOM (montagem, reset do formulário). O eco da própria
  // digitação não re-renderiza: isso jogaria o cursor para o começo.
  useLayoutEffect(() => {
    const el = raiz.current;
    if (!el || emitido.current === valor) return;
    renderizar(el, valor, rotuloDe);
    emitido.current = valor;
  }, [valor, rotuloDe]);

  const emitir = useCallback(
    (texto: string) => {
      const final = limite ? texto.slice(0, limite) : texto;
      emitido.current = final;
      aoMudar(final);
    },
    [aoMudar, limite],
  );

  const posicaoDoCursor = useCallback(() => {
    const sel = window.getSelection();
    const el = caixa.current;
    if (!sel || sel.rangeCount === 0 || !el) return { x: 8, y: 32 };
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const base = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && r.left === 0) return { x: 8, y: 32 };
    return { x: Math.max(0, r.left - base.left), y: r.bottom - base.top + 4 };
  }, []);

  /** Depois de cada digitação: pílula para marcador fechado, e o seletor para `{{`. */
  const aoDigitar = useCallback(() => {
    const el = raiz.current;
    if (!el) return;
    let texto = serializar(el);
    let cursor = offsetDoCursor(el);

    // Um `{{nome}}` fechado DENTRO de um nó de texto vira pílula agora.
    const temMarcadorSolto = Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && MARCADOR_COMPLETO.test(n.textContent ?? ""),
    );
    if (temMarcadorSolto || el.querySelector("div,br")) {
      texto = texto.replace(/\{\{\s*([a-z][a-z0-9_]*|\d+)\s*\}\}/g, "{{$1}}");
      renderizar(el, texto, rotuloDe);
      if (cursor !== null) colocarCursor(el, Math.min(cursor, texto.length));
      cursor = offsetDoCursor(el);
    }
    emitir(texto);

    const antes = cursor === null ? "" : texto.slice(0, cursor);
    const aberto = /\{\{([a-z0-9_]*)$/i.exec(antes);
    if (aberto) {
      setMenu({ consulta: aberto[1] ?? "", ...posicaoDoCursor(), pelaTecla: true });
      setIndice(0);
    } else if (menu?.pelaTecla) {
      setMenu(null);
    }
  }, [emitir, menu, posicaoDoCursor, rotuloDe]);

  /** Insere a pílula no cursor, trocando o `{{consulta` digitado, se houver. */
  const inserir = useCallback(
    (nome: string) => {
      const el = raiz.current;
      if (!el) return;
      const texto = serializar(el);
      const cursor = offsetDoCursor(el) ?? texto.length;
      let inicio = cursor;
      if (menu?.pelaTecla) {
        const aberto = /\{\{([a-z0-9_]*)$/i.exec(texto.slice(0, cursor));
        if (aberto) inicio = cursor - aberto[0].length;
      }
      const marcador = `{{${nome}}}`;
      const novo = `${texto.slice(0, inicio)}${marcador}${texto.slice(cursor)}`;
      renderizar(el, novo, rotuloDe);
      el.focus();
      colocarCursor(el, inicio + marcador.length);
      emitir(novo);
      setMenu(null);
    },
    [emitir, menu, rotuloDe],
  );

  // O que o seletor mostra: a categoria ativa, filtrada pela consulta.
  const consulta = (menu?.consulta ?? "").toLowerCase();
  const casa = (f: CampoDoSeletor) => f.chave.includes(consulta) || f.rotulo.toLowerCase().includes(consulta);
  const escolhida = categorias.find((c) => c.id === categoriaAtiva) ?? categorias[0];
  // Consulta digitada que só casa campo de OUTRA categoria: mostra essa.
  const categoriaMostrada =
    consulta && escolhida && !escolhida.campos.some(casa)
      ? (categorias.find((c) => c.campos.some(casa)) ?? escolhida)
      : escolhida;
  const filtrados = !categoriaMostrada
    ? []
    : consulta
      ? categoriaMostrada.campos.filter(casa)
      : categoriaMostrada.campos;
  const podeCriar =
    !!consulta && (NOME_VALIDO.test(consulta) || POSICIONAL.test(consulta)) && !rotulos.has(consulta);
  const opcoes = [...filtrados.map((f) => f.chave), ...(podeCriar ? [consulta] : [])];

  // Clique fora fecha o seletor.
  useEffect(() => {
    if (!menu) return;
    const fechar = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, [menu]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndice((i) => Math.min(i + 1, Math.max(opcoes.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndice((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && opcoes[indice]) {
        e.preventDefault();
        inserir(opcoes[indice]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (umaLinha) return;
      // Quebra de linha como TEXTO, não <div>: o valor é texto puro.
      document.execCommand("insertText", false, "\n");
    }
  };

  const vazio = !valor;

  return (
    <div ref={caixa} className="relative">
      <div
        ref={raiz}
        role="textbox"
        aria-multiline={!umaLinha}
        aria-label={rotuloAcessivel}
        aria-invalid={invalido || undefined}
        data-testid={testId}
        contentEditable
        suppressContentEditableWarning
        onInput={aoDigitar}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          // Colar entra como TEXTO puro; os marcadores colados viram pílula.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        className={cn(
          "whitespace-pre-wrap break-words rounded-md border bg-background px-2 py-1.5 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          umaLinha ? "min-h-9 leading-6" : "min-h-24",
          invalido ? "border-destructive" : "border-input",
        )}
      />
      {vazio && placeholder && (
        <span className="pointer-events-none absolute left-2 top-1.5 text-sm text-muted-foreground">{placeholder}</span>
      )}
      <button
        type="button"
        aria-label={t("Inserir variável")}
        title={t("Inserir variável")}
        onMouseDown={(e) => {
          e.preventDefault();
          const el = raiz.current;
          if (el && document.activeElement !== el) {
            el.focus();
            colocarCursor(el, serializar(el).length);
          }
          setMenu(menu ? null : { consulta: "", ...posicaoDoCursor(), pelaTecla: false });
          setIndice(0);
        }}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <BracketsCurly size={16} aria-hidden />
      </button>

      {menu && (
        <div
          role="listbox"
          aria-label={t("Variáveis")}
          data-testid="seletor-de-variaveis"
          style={{ left: Math.min(menu.x, 240), top: menu.y }}
          className="absolute z-50 flex max-h-72 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-popover text-sm shadow-lg"
        >
          <div className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border p-1">
            {categorias.map((c) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setCategoriaAtiva(c.id);
                  setIndice(0);
                }}
                className={cn(
                  "rounded px-2 py-1.5 text-left text-xs leading-snug",
                  c.id === categoriaMostrada?.id ? "bg-muted font-medium" : "hover:bg-muted/60",
                )}
              >
                {c.rotulo}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {filtrados.length === 0 && !podeCriar && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {categoriaMostrada?.campos.length === 0 && categoriaMostrada.vazio
                  ? categoriaMostrada.vazio
                  : t("Nenhum campo encontrado.")}
              </p>
            )}
            {filtrados.map((f, i) => (
              <button
                key={f.chave}
                type="button"
                role="option"
                aria-selected={i === indice}
                onMouseDown={(e) => {
                  e.preventDefault();
                  inserir(f.chave);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
                  i === indice ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <Icone tipo={f.icone} />
                <span className="truncate">{f.rotulo}</span>
              </button>
            ))}
            {podeCriar && (
              <button
                type="button"
                role="option"
                aria-selected={indice === filtrados.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  inserir(consulta);
                }}
                className={cn(
                  "mt-0.5 flex w-full items-center gap-2 rounded border-t border-border px-2 py-1.5 text-left",
                  indice === filtrados.length ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <BracketsCurly size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {t("Criar variável")} <span className="font-mono text-xs">{`{{${consulta}}}`}</span>
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** As variáveis do texto, na ordem, com o rótulo que a pílula mostra. */
export function variaveisParaExemplo(
  texto: string,
  categorias: CategoriaDoSeletor[],
): Array<{ nome: string; rotulo: string }> {
  const rotulos = new Map<string, string>();
  for (const c of categorias) for (const f of c.campos) if (!rotulos.has(f.chave)) rotulos.set(f.chave, f.rotulo);
  return lerVariaveis(texto).variaveis.map((v) => ({ nome: v.nome, rotulo: rotulos.get(v.nome) ?? v.nome }));
}
