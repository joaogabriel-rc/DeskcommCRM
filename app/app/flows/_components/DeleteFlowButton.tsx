"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Trash } from "@/lib/ui/icons";
import { useDeleteFlow } from "@/hooks/flows/useFlows";
import { useT } from "@/lib/i18n/IdiomaProvider";

interface Props {
  flowId: string;
  flowName: string;
}

export function DeleteFlowButton({ flowId, flowName }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const del = useDeleteFlow();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={del.isPending}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Trash size={14} aria-hidden className="mr-1" />
        {t("Excluir")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir")} &ldquo;{flowName}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Os nós, conexões e o histórico de execuções deste flow são apagados junto. Não é possível desfazer.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault();
                del.mutate(flowId, { onSuccess: () => setOpen(false) });
              }}
            >
              {del.isPending ? t("Excluindo…") : t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
