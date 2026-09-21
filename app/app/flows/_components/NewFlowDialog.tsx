"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORIA_LABEL, FLOW_TRIGGERS, type FlowTriggerId } from "@/lib/flows/triggers";
import { useCreateFlow } from "@/hooks/flows/useFlows";
import { useT } from "@/lib/i18n/IdiomaProvider";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GATILHOS = Object.values(FLOW_TRIGGERS);

/**
 * Criar um flow pede duas coisas: o nome e O QUE O INICIA. O gatilho aparece
 * aqui — e não como se todo flow fosse "de tag" — e continua trocável no
 * canvas depois.
 */
export function NewFlowDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<FlowTriggerId>("contact_tag_added");
  const [valorDoCampo, setValorDoCampo] = useState("");
  const create = useCreateFlow();
  const router = useRouter();

  const def = FLOW_TRIGGERS[triggerType];
  const precisaDeValor = def.field?.required ?? false;
  const podeCriar = name.trim().length > 0 && (!precisaDeValor || valorDoCampo.trim().length > 0);

  function handleSubmit() {
    if (!podeCriar) return;
    const trigger_config = def.field && valorDoCampo.trim() ? { [def.field.key]: valorDoCampo.trim() } : {};
    create.mutate(
      { name: name.trim(), trigger_type: triggerType, trigger_config },
      {
        onSuccess: (created) => {
          onOpenChange(false);
          setName("");
          setValorDoCampo("");
          router.push(`/app/flows/${created.id}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo flow")}</DialogTitle>
          <DialogDescription>
            {t("Dê um nome e escolha o que inicia a automação. Você monta os passos no canvas depois.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flow-name">{t("Nome")}</Label>
            <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Boas-vindas")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flow-trigger">{t("Iniciar automação quando…")}</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => {
                setTriggerType(v as FlowTriggerId);
                setValorDoCampo("");
              }}
            >
              <SelectTrigger id="flow-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GATILHOS.map((gatilho) => (
                  <SelectItem key={gatilho.id} value={gatilho.id}>
                    {t(CATEGORIA_LABEL[gatilho.category])} · {t(gatilho.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">{t(def.description)}</p>
          </div>

          {def.field && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flow-trigger-field">{t(def.field.label)}</Label>
              <Input
                id="flow-trigger-field"
                value={valorDoCampo}
                onChange={(e) => setValorDoCampo(e.target.value)}
                placeholder={def.field.placeholder ? t(def.field.placeholder) : undefined}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={create.isPending || !podeCriar}>
            {create.isPending ? t("Criando…") : t("Criar e abrir")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
