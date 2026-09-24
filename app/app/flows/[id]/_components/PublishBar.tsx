"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useFlowExecutions, useRenameFlow, useUpdateFlowStatus, type FlowDetailRow } from "@/hooks/flows/useFlow";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import Link from "next/link";

import { useT } from "@/lib/i18n/IdiomaProvider";
import { ClockCounterClockwise } from "@/lib/ui/icons";
import { resumoDoGatilho } from "@/lib/flows/triggers";

interface Props {
  flowId: string;
  flow: FlowDetailRow;
  onSave: () => void;
  saving: boolean;
}

const STATUS_LABEL: Record<FlowDetailRow["status"], string> = {
  draft: "Rascunho",
  active: "Ativo",
  archived: "Arquivado",
};

const STATUS_VARIANT: Record<FlowDetailRow["status"], "secondary" | "default" | "outline"> = {
  draft: "secondary",
  active: "default",
  archived: "outline",
};

export function PublishBar({ flowId, flow, onSave, saving }: Props) {
  const t = useT();
  // A data da execução segue o idioma escolhido; `"pt-BR"` fixo mostrava o
  // formato brasileiro para quem lê em espanhol.
  const tagDoIdioma = useTagDeIdioma();
  const updateStatus = useUpdateFlowStatus(flowId);
  const [activityOpen, setActivityOpen] = useState(false);
  const executions = useFlowExecutions(flowId, activityOpen);
  const renomear = useRenameFlow(flowId);
  const [nome, setNome] = useState(flow.name);
  const isActive = flow.status === "active";
  // Fluxo de DISPARO (0394): liga e desliga com o disparo, não por aqui.
  const doDisparo = !!flow.broadcast_id;

  // O fluxo nasce "Sem título" (abre direto no construtor): o nome se edita aqui,
  // e é gravado ao sair do campo — sem botão a mais para um gesto de uma palavra.
  function gravarNome() {
    const limpo = nome.trim();
    if (!limpo) {
      setNome(flow.name);
      return;
    }
    if (limpo !== flow.name) renomear.mutate(limpo);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
      <div className="flex items-center gap-3">
        <Input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          onBlur={gravarNome}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          maxLength={120}
          aria-label={t("Nome do fluxo")}
          className="h-8 w-56 font-medium"
          data-testid="nome-do-fluxo"
        />
        <Badge variant={STATUS_VARIANT[flow.status]}>{t(STATUS_LABEL[flow.status])}</Badge>
        {doDisparo && (
          <Link
            href={`/app/disparos/${flow.broadcast_id}`}
            className="rounded-md border border-accent-400 px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
            data-testid="fluxo-do-disparo"
          >
            {t("Fluxo do disparo — voltar ao disparo")}
          </Link>
        )}
        <span className="text-xs text-text-muted">
          {t(resumoDoGatilho(flow.trigger_type, flow.trigger_config))} · v{flow.version}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setActivityOpen(true)}>
          <ClockCounterClockwise size={14} aria-hidden className="mr-1.5" />
          {t("Atividade")}
        </Button>
        {!isActive && (
          <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={saving}>
            {saving ? t("Salvando…") : t("Salvar")}
          </Button>
        )}
        {!doDisparo && (
          <Button
            type="button"
            size="sm"
            variant={isActive ? "destructive" : "default"}
            onClick={() => updateStatus.mutate(isActive ? "draft" : "active")}
            disabled={updateStatus.isPending}
          >
            {isActive ? t("Pausar") : t("Ativar")}
          </Button>
        )}
      </div>

      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        <SheetContent side="right" className="w-full max-w-md">
          <SheetHeader>
            <SheetTitle>
              {t("Atividade")} — {flow.name}
            </SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-2 overflow-y-auto p-4 pt-0">
            {executions.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
            {executions.data?.length === 0 && (
              <p className="text-sm text-text-muted">{t("Nenhuma execução ainda.")}</p>
            )}
            {executions.data?.map((e) => (
              <div key={e.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {rotuloDoContato(e.contacts, t)}
                  </span>
                  <Badge variant={e.status === "failed" ? "destructive" : "secondary"}>{e.status}</Badge>
                </div>
                {e.waiting_for && (
                  <p className="mt-1 text-xs text-text-muted">
                    {t("Esperando:")} {e.waiting_for}
                  </p>
                )}
                {e.last_error && <p className="mt-1 text-xs text-error-fg">{e.last_error}</p>}
                <p className="mt-1 text-xs text-text-muted">
                  {t("Iniciado em")} {new Date(e.started_at).toLocaleString(tagDoIdioma)}
                </p>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
