"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { FlowArrow, Plus } from "@/lib/ui/icons";
import { resumoDoGatilho } from "@/lib/flows/triggers";
import { useFlows, type FlowRow } from "@/hooks/flows/useFlows";
import { DeleteFlowButton } from "./DeleteFlowButton";
import { FlowStatusBadge } from "./FlowStatusBadge";
import { NewFlowDialog } from "./NewFlowDialog";

interface Props {
  initialData: FlowRow[];
  canWrite: boolean;
}

export function FlowsList({ initialData, canWrite }: Props) {
  const t = useT();
  // A data segue o idioma escolhido, não o do autor do código: `"pt-BR"` fixo
  // mostrava 20/09/2026 para quem lê em espanhol.
  const tagDoIdioma = useTagDeIdioma();
  const { data } = useFlows({ initialData });
  const [dialogOpen, setDialogOpen] = useState(false);
  const flows = data ?? [];

  const newFlowButton = (
    <Button onClick={() => setDialogOpen(true)} className="w-full sm:w-auto">
      <Plus size={14} aria-hidden className="mr-2" /> {t("Novo flow")}
    </Button>
  );

  if (flows.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">{t("Nenhum flow ainda")}</h2>
          <p className="max-w-sm text-sm text-text-muted">
            {t(
              "Um flow começa por um GATILHO que você escolhe — contato novo, tag aplicada, campo alterado, mensagem recebida, negócio que mudou de etapa. Dali ele manda mensagens, pergunta com botões e leva o contato por caminhos diferentes conforme a resposta.",
            )}
          </p>
          {canWrite && <div className="mt-1">{newFlowButton}</div>}
        </Card>
        {canWrite && <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite && <div className="flex sm:justify-end">{newFlowButton}</div>}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {flows.map((flow) => (
          <li key={flow.id}>
            <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-accent-400">
              <Link href={`/app/flows/${flow.id}`} className="flex flex-1 flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1 truncate font-medium" title={flow.name}>
                    {flow.name}
                  </h3>
                  <FlowStatusBadge status={flow.status} />
                </div>
                <p className="text-xs text-text-muted">
                  {resumoDoGatilho(flow.trigger_type, flow.trigger_config)}
                </p>
                <p className="mt-auto pt-2 text-xs text-text-muted">
                  {t("Atualizado em")} {new Date(flow.updated_at).toLocaleDateString(tagDoIdioma)}
                </p>
              </Link>
              {canWrite && (
                <div className="flex justify-end border-t border-border pt-2">
                  <DeleteFlowButton flowId={flow.id} flowName={flow.name} />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {canWrite && <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}
