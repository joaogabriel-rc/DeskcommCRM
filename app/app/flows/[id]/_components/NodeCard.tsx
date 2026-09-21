"use client";

import { Handle, Position } from "@xyflow/react";

import { cn } from "@/lib/utils";
import type { NodeVisual } from "./nodeVisuals";

export interface NodeCardHandle {
  id: string | null;
  label: string;
}

interface Props {
  id: string;
  visual: NodeVisual;
  label: string;
  subtitle: string;
  selected?: boolean;
  errors?: string[];
  showTarget?: boolean;
  /** O nó final não tem para onde seguir — nem bolinha de saída. */
  showSource?: boolean;
  /** Uma linha por saída nomeada (botões da mensagem, sim/não da condição). */
  handles?: NodeCardHandle[];
}

/**
 * Shell compartilhado por todo nó do Flow Builder: chip de ícone + título +
 * resumo da config + handles de conexão, borda esquerda no tom do tipo. Mesmo
 * padrão visual do builder de follow-up (app/app/ai/followups), sem
 * depender do contexto dele (EtapasDoFluxo é específico daquele produto).
 */
export function NodeCard({
  id,
  visual,
  label,
  subtitle,
  selected,
  errors,
  showTarget = true,
  showSource = true,
  handles,
}: Props) {
  const Icon = visual.icon;
  const hasError = (errors?.length ?? 0) > 0;
  // Uma saída NOMEADA já vira linha própria: um nó com um único botão precisa
  // que a aresta nasça com `sourceHandle = 'button:0'`, senão o motor procura
  // essa saída e não acha — a bolinha anônima do rodapé gravaria `null`.
  const rows = handles && handles.length > 0 ? handles : null;

  return (
    <div
      className={cn(
        "w-60 rounded-md border border-l-4 border-border bg-surface shadow-sm transition-shadow",
        visual.borderClassName,
        selected && "ring-2 ring-accent-500 ring-offset-1 ring-offset-bg",
        hasError && "border-error ring-2 ring-error ring-offset-1 ring-offset-bg",
      )}
      data-testid={`node-card-${id}`}
      title={hasError ? errors!.join("; ") : undefined}
    >
      {showTarget && <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            visual.chipClassName,
          )}
        >
          <Icon size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text" title={label}>
            {label}
          </p>
          <p className="line-clamp-2 break-words text-xs text-text-muted" title={subtitle}>
            {subtitle}
          </p>
        </div>
      </div>
      {hasError && (
        <p className="border-t border-error/30 px-3 py-1.5 text-xs leading-snug text-error-fg">{errors![0]}</p>
      )}
      {rows !== null && (
        <ul className="border-t border-border">
          {rows.map((h) => (
            <li
              key={h.id ?? "default"}
              className="relative flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 first:border-t-0"
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
              <span className="line-clamp-1 break-words text-xs leading-tight">{h.label}</span>
              <Handle type="source" id={h.id ?? undefined} position={Position.Right} style={{ top: "50%" }} />
            </li>
          ))}
        </ul>
      )}
      {rows === null && showSource && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}
