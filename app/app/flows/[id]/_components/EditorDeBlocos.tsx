"use client";

/**
 * O EDITOR DE BLOCOS do nó "Enviar mensagem" — o mesmo nos dois construtores:
 * Automações e Disparos em modo fluxo (os dois são `/app/flows/[id]`).
 *
 * Um nó, vários blocos em sequência: texto, imagem e atraso ("Aguardando por 3
 * segundos…"). Cada texto pode ter botões, e cada botão faz UMA de duas coisas:
 * abre um site (URL) ou é uma saída do fluxo (sem URL). O "Próximo passo" do nó
 * não é um botão — é a saída de baixo do card, e o fluxo segue por ela mesmo
 * que ninguém clique. A estrutura e as regras moram em `lib/flows/blocos.ts`.
 *
 * Nó antigo (`body` + `buttons`) abre aqui como um bloco de texto; a primeira
 * edição grava o formato novo, mantendo as saídas `button:<i>` que as setas já
 * usam.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { InserirVariavel } from "@/components/catalogo/InserirVariavel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ATRASO_MAX_SEGUNDOS,
  ATRASO_MIN_SEGUNDOS,
  blocosDaMensagem,
  LIMITE_DE_BLOCOS,
  LIMITE_DE_BOTOES_POR_TEXTO,
  LIMITE_ROTULO_DO_BOTAO,
  urlDeBotaoValida,
  type BlocoDaMensagem,
  type BlocoDeImagem,
  type BotaoDoBloco,
} from "@/lib/flows/blocos";
import type { MessageNodeConfig } from "@/lib/flows/types";
import { randomId } from "@/lib/random-id";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ChatCircle, Clock, ImageSquare, LinkSimple, Plus, Trash, X } from "@/lib/ui/icons";

/** Fora de secure context (HTTP numa VPS sem TLS) `crypto.randomUUID` não existe: `randomId` cobre os dois. */
const novoId = randomId;

type Unidade = "s" | "min" | "h";
const FATOR: Record<Unidade, number> = { s: 1, min: 60, h: 3600 };

function paraUnidade(segundos: number): { valor: number; unidade: Unidade } {
  if (segundos >= 3600 && segundos % 3600 === 0) return { valor: segundos / 3600, unidade: "h" };
  if (segundos >= 60 && segundos % 60 === 0) return { valor: segundos / 60, unidade: "min" };
  return { valor: segundos, unidade: "s" };
}

export function EditorDeBlocos({
  flowId,
  config,
  patch,
}: {
  flowId: string;
  config: MessageNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  const blocos = blocosDaMensagem(config);

  // Grava SEMPRE no formato novo; `body`/`buttons` saem para não haver duas fontes.
  const gravar = (proximos: BlocoDaMensagem[]) => patch({ blocks: proximos, body: undefined, buttons: undefined });
  const trocar = (i: number, b: BlocoDaMensagem) => gravar(blocos.map((x, j) => (j === i ? b : x)));
  const mover = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocos.length) return;
    const p = [...blocos];
    [p[i], p[j]] = [p[j]!, p[i]!];
    gravar(p);
  };
  const remover = (i: number) => gravar(blocos.filter((_, j) => j !== i));
  const adicionar = (b: BlocoDaMensagem) => {
    if (blocos.length >= LIMITE_DE_BLOCOS) {
      toast.error(t("Limite de blocos por mensagem atingido."));
      return;
    }
    gravar([...blocos, b]);
  };
  const adicionarBotao = () => {
    // O botão vive num texto: vai para o último texto com espaço, ou nasce com um.
    const botao: BotaoDoBloco = { id: novoId(), rotulo: t("Botão"), acao: "fluxo" };
    for (let i = blocos.length - 1; i >= 0; i--) {
      const b = blocos[i]!;
      if (b.tipo === "texto" && (b.botoes ?? []).length < LIMITE_DE_BOTOES_POR_TEXTO) {
        trocar(i, { ...b, botoes: [...(b.botoes ?? []), botao] });
        return;
      }
    }
    adicionar({ id: novoId(), tipo: "texto", texto: "", botoes: [botao] });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="editor-de-blocos">
      {blocos.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
          {t("A mensagem ainda está vazia. Adicione um bloco abaixo.")}
        </p>
      )}

      {blocos.map((b, i) => (
        <div
          key={b.id}
          className="rounded-md border border-border bg-surface p-2.5"
          data-testid={`bloco-${b.tipo}`}
          data-bloco-indice={i}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
              {b.tipo === "texto" ? (
                <ChatCircle size={14} aria-hidden />
              ) : b.tipo === "imagem" ? (
                <ImageSquare size={14} aria-hidden />
              ) : (
                <Clock size={14} aria-hidden />
              )}
              {b.tipo === "texto" ? t("Texto") : b.tipo === "imagem" ? t("Imagem") : t("Atraso")}
            </span>
            <div className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={i === 0}
                onClick={() => mover(i, -1)}
                aria-label={`${t("Mover para cima")} ${i + 1}`}
              >
                <ArrowUp size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={i === blocos.length - 1}
                onClick={() => mover(i, 1)}
                aria-label={`${t("Mover para baixo")} ${i + 1}`}
              >
                <ArrowDown size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => remover(i)}
                aria-label={`${t("Remover bloco")} ${i + 1}`}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
          </div>

          {b.tipo === "texto" && <BlocoTexto bloco={b} aoMudar={(x) => trocar(i, x)} />}
          {b.tipo === "imagem" && <BlocoImagem flowId={flowId} bloco={b} aoMudar={(x) => trocar(i, x)} />}
          {b.tipo === "atraso" && (
            <BlocoAtraso segundos={b.segundos} aoMudar={(segundos) => trocar(i, { ...b, segundos })} />
          )}
        </div>
      ))}

      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-text-muted">{t("Adicione um dos blocos de conteúdo:")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => adicionar({ id: novoId(), tipo: "texto", texto: "" })}
            data-testid="adicionar-texto"
          >
            <ChatCircle size={14} aria-hidden className="mr-1" /> {t("Texto")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => adicionar({ id: novoId(), tipo: "imagem" })}
            data-testid="adicionar-imagem"
          >
            <ImageSquare size={14} aria-hidden className="mr-1" /> {t("Imagem")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => adicionar({ id: novoId(), tipo: "atraso", segundos: 3 })}
            data-testid="adicionar-atraso"
          >
            <Clock size={14} aria-hidden className="mr-1" /> {t("Atraso")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={adicionarBotao} data-testid="adicionar-botao">
            <Plus size={14} aria-hidden className="mr-1" /> {t("Botão")}
          </Button>
        </div>
      </div>

      <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-snug text-text-muted">
        {t(
          "O Próximo passo (a saída de baixo do card) não é um botão: o fluxo segue por ele assim que a mensagem sai, mesmo que ninguém clique. Um botão sem link vira uma saída própria; se o contato clicar depois, o fluxo desvia para ela. Um botão com link só abre o site.",
        )}
      </p>
    </div>
  );
}

function BlocoTexto({ bloco, aoMudar }: { bloco: Extract<BlocoDaMensagem, { tipo: "texto" }>; aoMudar: (b: Extract<BlocoDaMensagem, { tipo: "texto" }>) => void }) {
  const t = useT();
  const botoes = bloco.botoes ?? [];
  const trocarBotao = (i: number, b: BotaoDoBloco) => aoMudar({ ...bloco, botoes: botoes.map((x, j) => (j === i ? b : x)) });

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        rows={4}
        value={bloco.texto}
        aria-label={t("Texto da mensagem")}
        onChange={(e) => aoMudar({ ...bloco, texto: e.target.value })}
      />
      <div className="flex justify-end">
        <InserirVariavel onInserir={(v) => aoMudar({ ...bloco, texto: `${bloco.texto}${v}` })} />
      </div>

      {botoes.map((b, i) => (
        <div key={b.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2" data-testid="botao-do-bloco">
          <div className="flex items-center gap-1.5">
            <Input
              value={b.rotulo}
              maxLength={LIMITE_ROTULO_DO_BOTAO}
              aria-label={t("Título do botão")}
              placeholder={t("Título do botão")}
              onChange={(e) => trocarBotao(i, { ...b, rotulo: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => aoMudar({ ...bloco, botoes: botoes.filter((_, j) => j !== i) })}
              aria-label={t("Remover botão")}
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
          <Select
            value={b.acao}
            onValueChange={(v) =>
              trocarBotao(i, v === "url" ? { ...b, acao: "url", url: b.url ?? "" } : { id: b.id, rotulo: b.rotulo, acao: "fluxo" })
            }
          >
            <SelectTrigger aria-label={t("Quando este botão é pressionado")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fluxo">{t("Seguir para uma etapa do fluxo")}</SelectItem>
              <SelectItem value="url">{t("Abrir site")}</SelectItem>
            </SelectContent>
          </Select>
          {b.acao === "url" ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <LinkSimple size={14} aria-hidden className="shrink-0 text-text-muted" />
                <Input
                  value={b.url ?? ""}
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  aria-label={t("URL do site")}
                  aria-invalid={!urlDeBotaoValida(b.url) || undefined}
                  className={cn(!urlDeBotaoValida(b.url) && "border-error")}
                  onChange={(e) => trocarBotao(i, { ...b, url: e.target.value })}
                />
              </div>
              {!urlDeBotaoValida(b.url) && (
                <p className="text-[11px] text-error-fg">{t("Informe o endereço completo do site (https://…).")}</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-text-muted">
              {t("Ligue a saída deste botão, no card, à etapa que ele deve abrir.")}
            </p>
          )}
        </div>
      ))}
      {botoes.length < LIMITE_DE_BOTOES_POR_TEXTO && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => aoMudar({ ...bloco, botoes: [...botoes, { id: novoId(), rotulo: "", acao: "fluxo" }] })}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar botão")} ({botoes.length}/{LIMITE_DE_BOTOES_POR_TEXTO})
        </Button>
      )}
    </div>
  );
}

function BlocoImagem({ flowId, bloco, aoMudar }: { flowId: string; bloco: BlocoDeImagem; aoMudar: (b: BlocoDeImagem) => void }) {
  const t = useT();
  const [subindo, setSubindo] = useState(false);
  const [previa, setPrevia] = useState<string | null>(null);

  // A prévia é um link assinado CURTO: pedido de novo a cada abertura do painel.
  useEffect(() => {
    if (!bloco.media_storage_path) return;
    let vivo = true;
    fetch(`/api/v1/flows/${flowId}/media?path=${encodeURIComponent(bloco.media_storage_path)}`)
      .then((r) => r.json())
      .then((j: { data?: { url?: string } }) => {
        if (vivo) setPrevia(j.data?.url ?? null);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [flowId, bloco.media_storage_path]);

  return (
    <div className="flex flex-col gap-2">
      {bloco.media_storage_path && previa && (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado e temporário; o otimizador o buscaria de novo depois de expirar
        <img src={previa} alt={t("Imagem do bloco")} className="max-h-40 w-full rounded-md object-contain" />
      )}
      <label
        className={cn(
          "flex h-9 cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-2 text-sm text-text-muted hover:bg-muted",
          subindo && "pointer-events-none opacity-60",
        )}
      >
        {subindo ? t("Subindo…") : bloco.media_storage_path ? t("Trocar imagem") : t("Subir imagem (JPG/PNG)")}
        <input
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          aria-label={t("Imagem do bloco")}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setSubindo(true);
            try {
              const fd = new FormData();
              fd.append("file", f);
              const r = await fetch(`/api/v1/flows/${flowId}/media`, { method: "POST", body: fd });
              const j = (await r.json()) as {
                data?: { storage_path?: string; media_mime?: string; url?: string };
                error?: { message?: string };
              };
              if (!r.ok || !j.data?.storage_path) {
                toast.error(t(j.error?.message ?? "Não consegui subir a imagem."));
                return;
              }
              setPrevia(j.data.url ?? null);
              aoMudar({ ...bloco, media_storage_path: j.data.storage_path, media_mime: j.data.media_mime });
            } finally {
              setSubindo(false);
              e.target.value = "";
            }
          }}
        />
      </label>
      <Input
        value={bloco.legenda ?? ""}
        placeholder={t("Legenda (opcional)")}
        aria-label={t("Legenda da imagem")}
        onChange={(e) => aoMudar({ ...bloco, legenda: e.target.value })}
      />
    </div>
  );
}

function BlocoAtraso({ segundos, aoMudar }: { segundos: number; aoMudar: (s: number) => void }) {
  const t = useT();
  const { valor, unidade } = paraUnidade(Number(segundos) || ATRASO_MIN_SEGUNDOS);
  const aplicar = (v: number, u: Unidade) => {
    const s = Math.round((Number(v) || 0) * FATOR[u]);
    aoMudar(Math.min(Math.max(s, ATRASO_MIN_SEGUNDOS), ATRASO_MAX_SEGUNDOS));
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted">{t("Aguardar")}</span>
      <Input
        type="number"
        min={1}
        value={valor}
        aria-label={t("Duração do atraso")}
        className="w-20"
        onChange={(e) => aplicar(Number(e.target.value), unidade)}
      />
      <Select value={unidade} onValueChange={(u) => aplicar(valor, u as Unidade)}>
        <SelectTrigger className="w-32" aria-label={t("Unidade do atraso")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="s">{t("segundos")}</SelectItem>
          <SelectItem value="min">{t("minutos")}</SelectItem>
          <SelectItem value="h">{t("horas")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
