"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";
import { ACOES_DO_FLOW, CATEGORIA_DE_ACAO_LABEL, type CategoriaDeAcao } from "@/lib/flows/acoes";
import type { FlowNodeType } from "@/lib/flows/types";
import { NODE_VISUALS } from "./nodeVisuals";

export interface EscolhaDePasso {
  type: FlowNodeType;
  /** Só para ACTION: já nasce com a ação escolhida da biblioteca. */
  actionType?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEscolher: (escolha: EscolhaDePasso) => void;
}

const TIPOS_DE_PASSO: FlowNodeType[] = ["MESSAGE", "ACTION", "CONDITION", "DELAY", "WEBHOOK", "END"];
const CATEGORIAS: CategoriaDeAcao[] = ["contato", "conversa", "automacao", "integracao"];

/**
 * O "+" do canvas: escolher o PRÓXIMO PASSO.
 *
 * Duas camadas na mesma tela, porque são duas perguntas diferentes: que tipo
 * de passo (mensagem, condição, espera…), e — quando é uma ação — QUAL ação da
 * biblioteca. Escolher a ação aqui evita o passo intermediário de criar um nó
 * vazio e só depois descobrir o que ele faz.
 */
export function StepPicker({ open, onOpenChange, onEscolher }: Props) {
  const t = useT();
  const [categoria, setCategoria] = useState<CategoriaDeAcao>("contato");

  function escolher(escolha: EscolhaDePasso) {
    onEscolher(escolha);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Adicionar passo")}</DialogTitle>
          <DialogDescription>
            {t("O que acontece depois? Escolha o tipo de passo ou uma ação pronta.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {TIPOS_DE_PASSO.map((type) => {
            const visual = NODE_VISUALS[type];
            const Icon = visual.icon;
            return (
              <button
                key={type}
                type="button"
                onClick={() => escolher({ type })}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-accent-400"
              >
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", visual.chipClassName)}>
                  <Icon size={14} aria-hidden />
                </span>
                {t(visual.paletteLabel)}
              </button>
            );
          })}
        </div>

        <div className="mt-2 border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            {t("Realize as seguintes ações…")}
          </p>
          <div className="flex max-h-[45vh] gap-4 overflow-hidden">
            <nav className="flex w-44 shrink-0 flex-col gap-1">
              {CATEGORIAS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategoria(c)}
                  className={cn(
                    "rounded-md px-3 py-2 text-left text-sm transition-colors",
                    c === categoria ? "bg-surface-elevated font-medium text-text" : "text-text-muted hover:text-text",
                  )}
                >
                  {t(CATEGORIA_DE_ACAO_LABEL[c])}
                </button>
              ))}
            </nav>
            <ul className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {ACOES_DO_FLOW.filter((a) => a.categoria === categoria).map((a) => (
                <li key={a.type}>
                  <button
                    type="button"
                    onClick={() => escolher({ type: "ACTION", actionType: a.type })}
                    className="w-full rounded-md border border-border p-3 text-left transition-colors hover:border-accent-400"
                  >
                    <p className="font-medium">{t(a.label)}</p>
                    <p className="text-xs text-text-muted">{t(a.descricao)}</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
