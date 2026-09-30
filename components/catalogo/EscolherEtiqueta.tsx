"use client";
/**
 * "+ Adicionar tag" — o botão que abre a lista pesquisável de etiquetas.
 *
 * Um POPOVER (portal, camada própria) e não um `Select`: o `Select` do Radix
 * sem item nenhum abria como uma barra vazia colada no gatilho, sem dizer por
 * quê, e não tem campo de busca — com duzentas etiquetas importadas, achar uma
 * era rolar a lista inteira. Aqui a lista tem busca, altura máxima com rolagem
 * própria, e o estado vazio é uma FRASE ("nenhuma etiqueta…"), nunca um vão.
 *
 * `modal`: dentro de um Dialog, o bloqueio de rolagem do Dialog engolia a roda
 * do mouse sobre a lista (que mora num portal fora dele). Popover modal traz o
 * próprio bloqueio e deixa a lista rolar.
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOpcoesDeEtiqueta } from "@/hooks/catalogo/useOpcoesDeEtiqueta";
import { useT } from "@/hooks/i18n/useT";
import { MagnifyingGlass, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export function EscolherEtiqueta({
  jaEscolhidas,
  onEscolher,
  permitirNova = true,
  rotulo,
  disabled,
  className,
  testId,
}: {
  /** O que já está aplicado — some da lista (sem diferenciar maiúsculas). */
  jaEscolhidas: readonly string[];
  onEscolher: (nome: string) => void;
  /** `true` = o texto buscado que não existe vira "Criar tag …". */
  permitirNova?: boolean;
  rotulo?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const { opcoes, carregando } = useOpcoesDeEtiqueta();

  const escolhidas = useMemo(
    () => new Set(jaEscolhidas.map((v) => v.trim().toLowerCase())),
    [jaEscolhidas],
  );
  const termo = busca.trim().toLowerCase();
  const disponiveis = opcoes.filter(
    (nome) => !escolhidas.has(nome.toLowerCase()) && (!termo || nome.toLowerCase().includes(termo)),
  );
  const existeExata = opcoes.some((nome) => nome.toLowerCase() === termo);
  const podeCriar = permitirNova && termo !== "" && !existeExata && !escolhidas.has(termo);

  function escolher(nome: string) {
    onEscolher(nome.trim());
    setBusca("");
    setAberto(false);
  }

  return (
    <Popover
      modal
      open={aberto}
      onOpenChange={(v) => {
        setAberto(v);
        if (!v) setBusca("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn("h-7 gap-1 px-2 text-xs text-accent-600 hover:text-accent-700", className)}
          data-testid={testId}
        >
          <Plus size={13} aria-hidden /> {rotulo ?? t("Adicionar tag")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" data-testid={testId ? `${testId}-lista` : undefined}>
        <div className="border-b border-border p-2">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
              aria-hidden
            />
            <Input
              autoFocus
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (disponiveis[0]) escolher(disponiveis[0]);
                else if (podeCriar) escolher(busca);
              }}
              placeholder={t("Buscar tag…")}
              aria-label={t("Buscar tag")}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <ul className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label={t("Tags")}>
          {carregando && opcoes.length === 0 ? (
            <li className="px-3 py-2 text-sm text-text-muted">{t("Carregando…")}</li>
          ) : null}
          {disponiveis.map((nome) => (
            <li key={nome}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => escolher(nome)}
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-hidden"
              >
                {nome}
              </button>
            </li>
          ))}
          {!carregando && disponiveis.length === 0 && !podeCriar ? (
            <li className="px-3 py-2 text-sm text-text-muted" data-testid="etiquetas-vazio">
              {opcoes.length === 0
                ? t("Nenhuma tag cadastrada ou aplicada ainda.")
                : termo
                  ? t("Nenhuma tag com esse nome.")
                  : t("Todas as tags já foram adicionadas.")}
            </li>
          ) : null}
        </ul>
        {podeCriar ? (
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => escolher(busca)}
              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm text-accent-600 hover:bg-surface-elevated"
            >
              <Plus size={13} aria-hidden /> {t("Criar tag")} “{busca.trim()}”
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
