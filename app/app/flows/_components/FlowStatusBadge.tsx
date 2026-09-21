import { Badge } from "@/components/ui/badge";
import type { FlowRow } from "@/hooks/flows/useFlows";

const LABEL: Record<FlowRow["status"], string> = { draft: "Rascunho", active: "Ativo", archived: "Arquivado" };
const VARIANT: Record<FlowRow["status"], "secondary" | "default" | "outline"> = {
  draft: "secondary",
  active: "default",
  archived: "outline",
};

export function FlowStatusBadge({ status }: { status: FlowRow["status"] }) {
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>;
}
