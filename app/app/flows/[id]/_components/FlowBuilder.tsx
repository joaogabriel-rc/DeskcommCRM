"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { FlowDetailRow } from "@/hooks/flows/useFlow";

/**
 * @xyflow/react é dependência pesada — só esta rota a carrega. `ssr:false` +
 * dynamic import a mantém fora do bundle principal (mesmo cuidado do builder
 * de follow-up, app/app/ai/followups/[id]/_components/FlowBuilder.tsx).
 */
const FlowCanvas = dynamic(() => import("./FlowCanvas").then((m) => m.FlowCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[600px] items-center justify-center p-6">
      <Skeleton className="h-full w-full" />
    </div>
  ),
});

interface Props {
  flowId: string;
  initialData: FlowDetailRow;
}

export function FlowBuilder({ flowId, initialData }: Props) {
  return (
    <div className="flex h-full min-h-[600px] flex-1 flex-col" data-testid="flow-builder-shell">
      <FlowCanvas flowId={flowId} initialData={initialData} />
    </div>
  );
}
