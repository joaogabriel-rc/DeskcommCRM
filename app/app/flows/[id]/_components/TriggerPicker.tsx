"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";
import {
  CATEGORIA_LABEL,
  FLOW_TRIGGERS,
  type FlowTriggerCategory,
  type FlowTriggerId,
} from "@/lib/flows/triggers";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  atual?: string;
  onEscolher: (id: FlowTriggerId) => void;
}

const CATEGORIAS: FlowTriggerCategory[] = ["contato", "whatsapp", "funil", "agenda"];

/**
 * "Iniciar automação quando…" — o gatilho é uma ESCOLHA do flow, e esta é a
 * tela onde ela acontece. Categorias à esquerda, opções à direita, busca no
 * topo: o mesmo gesto da referência, com os componentes daqui (Dialog, Input)
 * e sem nenhuma cor emprestada.
 *
 * Só aparecem gatilhos que o produto REALMENTE emite — a lista sai do
 * catálogo, não de um enum escrito à mão na tela.
 */
export function TriggerPicker({ open, onOpenChange, atual, onEscolher }: Props) {
  const traduzir = useT();
  const [categoria, setCategoria] = useState<FlowTriggerCategory>("contato");
  const [busca, setBusca] = useState("");

  const termo = busca.trim().toLowerCase();
  const visiveis = Object.values(FLOW_TRIGGERS).filter((t) => {
    if (termo) return t.label.toLowerCase().includes(termo) || t.description.toLowerCase().includes(termo);
    return t.category === categoria;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{traduzir("Iniciar automação quando…")}</DialogTitle>
          <DialogDescription>
            {traduzir(
              "O gatilho decide o que coloca um contato dentro deste fluxo. Tag é um deles — não o único.",
            )}
          </DialogDescription>
        </DialogHeader>

        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={traduzir("Pesquisar por evento")}
          className="mb-2"
        />

        <div className="flex max-h-[60vh] gap-4 overflow-hidden">
          {!termo && (
            <nav className="flex w-48 shrink-0 flex-col gap-1">
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
                  {traduzir(CATEGORIA_LABEL[c])}
                </button>
              ))}
            </nav>
          )}

          <ul className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {visiveis.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    onEscolher(t.id);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "w-full rounded-md border border-border p-3 text-left transition-colors hover:border-accent-400",
                    t.id === atual && "border-accent-500 bg-accent-soft",
                  )}
                >
                  <p className="text-xs text-text-muted">{traduzir(CATEGORIA_LABEL[t.category])}</p>
                  <p className="font-medium">{traduzir(t.label)}</p>
                  <p className="text-xs text-text-muted">{traduzir(t.description)}</p>
                </button>
              </li>
            ))}
            {visiveis.length === 0 && (
              <li className="p-3 text-sm text-text-muted">{traduzir("Nenhum gatilho com esse nome.")}</li>
            )}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
