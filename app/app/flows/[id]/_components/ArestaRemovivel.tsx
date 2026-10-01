"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  type EdgeProps,
} from "@xyflow/react";

import { useT } from "@/hooks/i18n/useT";
import { Trash } from "@/lib/ui/icons";

/**
 * A linha entre dois passos — e o jeito de apagá-la.
 *
 * Clicar na linha a SELECIONA (fica na cor de destaque) e mostra a lixeira no
 * meio dela; a lixeira apaga só a ligação: os dois passos ficam, e a saída de
 * origem volta a estar livre para ligar em outro passo. Delete/Backspace com a
 * linha selecionada fazem o mesmo (`deleteKeyCode` do canvas).
 *
 * A remoção passa por `deleteElements`, o mesmo caminho do teclado: vira um
 * `remove` em `onEdgesChange`, e o save seguinte grava o grafo sem ela
 * (`fn_flow_replace_graph` substitui as arestas inteiras).
 *
 * Fluxo ativo é só leitura no canvas — sem lixeira, porque não haveria como
 * gravar (a rota do grafo recusa com `flow_must_pause_to_edit_graph`).
 */
export function ArestaRemovivel({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
  style,
}: EdgeProps) {
  const t = useT();
  const { deleteElements } = useReactFlow();
  const editavel = useStore((s) => s.nodesConnectable);
  const [caminho, meioX, meioY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={caminho}
        markerEnd={markerEnd}
        interactionWidth={24}
        style={selected ? { ...style, stroke: "var(--color-accent)", strokeWidth: 2.5 } : style}
      />
      {selected && editavel && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{ transform: `translate(-50%, -50%) translate(${meioX}px, ${meioY}px)`, pointerEvents: "all" }}
          >
            <button
              type="button"
              onClick={() => void deleteElements({ edges: [{ id }] })}
              aria-label={t("Apagar conexão")}
              title={t("Apagar conexão")}
              data-testid={`apagar-aresta-${id}`}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-error-fg shadow-sm hover:bg-error/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash size={14} aria-hidden />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
