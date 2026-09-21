"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useCriarDisparo, useDisparos, useExcluirDisparo } from "@/hooks/disparos/useDisparos";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { Megaphone, Plus, Trash } from "@/lib/ui/icons";
import {
  SEGMENTO_VAZIO,
  STATUS_DE_DISPARO_LABEL,
  type DisparoRow,
  type StatusDeDisparo,
} from "@/lib/schemas/disparos";
import { resumoDoSegmento } from "@/lib/disparos/segmento";

/**
 * A cor do status é informação, não enfeite: `running` e `completed` são os dois
 * estados que o operador procura na lista, e distingui-los de relance é o que
 * evita abrir cinco disparos para achar o que está no ar.
 */
const TOM: Record<StatusDeDisparo, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  scheduled: "secondary",
  running: "default",
  paused: "secondary",
  completed: "secondary",
  cancelled: "outline",
  failed: "destructive",
};

export function DisparosList({ initialData }: { initialData: DisparoRow[] }) {
  const t = useT();
  const router = useRouter();
  const { data: disparos = [] } = useDisparos({ initialData });
  const criar = useCriarDisparo();
  const excluir = useExcluirDisparo();
  const [nome, setNome] = useState("");
  const [aberto, setAberto] = useState(false);

  async function criarDisparo() {
    const criado = await criar.mutateAsync({
      name: nome.trim(),
      segment: SEGMENTO_VAZIO,
      message: { window_mode: "outside_24h", body: "", template_values: {} },
      scheduled_at: null,
    });
    setAberto(false);
    setNome("");
    // Vai direto para o editor: um disparo recém-criado é um rascunho vazio, e
    // deixar o usuário na lista o obrigaria a procurar o que ele acabou de criar.
    router.push(`/app/disparos/${criado.id}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setAberto(true)}>
          <Plus size={16} aria-hidden className="mr-1" /> {t("Novo disparo")}
        </Button>
      </div>

      {disparos.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Megaphone size={32} aria-hidden className="text-text-muted" />
          <div>
            <p className="text-sm font-medium">{t("Nenhum disparo ainda")}</p>
            <p className="max-w-md text-sm text-text-muted">
              {t(
                "Um disparo escolhe um público pelas tags e campos do contato e manda a mesma mensagem para todo mundo dele, aos poucos. Crie o primeiro para ver a prévia de quantas pessoas ele alcança.",
              )}
            </p>
          </div>
          <Button onClick={() => setAberto(true)}>
            <Plus size={16} aria-hidden className="mr-1" /> {t("Novo disparo")}
          </Button>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border/60">
            {disparos.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <Link href={`/app/disparos/${d.id}`} className="text-sm font-medium hover:underline">
                    {d.name}
                  </Link>
                  <p className="text-xs text-text-muted">{resumoDoSegmento(d.segment)}</p>
                </div>
                <Badge variant={TOM[d.status]}>{t(STATUS_DE_DISPARO_LABEL[d.status])}</Badge>
                <span className="text-xs tabular-nums text-text-muted">
                  {/* O NÚMERO fica FORA do `t()`: `traduzir()` casa a string
                      exata, e uma frase montada em runtime nunca casaria chave
                      nenhuma — sairia em português para quem escolheu espanhol,
                      sem o guarda de i18n acusar. */}
                  {d.sent_count}/{d.total_recipients} {t("enviados")}
                  {d.failed_count > 0 && ` · ${d.failed_count} ${t("falhas")}`}
                  {d.skipped_count > 0 && ` · ${d.skipped_count} ${t("pulados")}`}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`${t("Excluir")} ${d.name}`}
                  // Um disparo que já enviou não some: a rota recusa com 409 e a
                  // explicação (o registro de quem recebeu é histórico).
                  onClick={() => excluir.mutate(d.id)}
                >
                  <Trash size={16} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Novo disparo")}</DialogTitle>
            <DialogDescription>
              {t(
                "Dê um nome para reconhecer depois. Na tela seguinte você escolhe o público e a mensagem — o disparo nasce como rascunho e nada sai até você agendar.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="disparo-nome">{t("Nome")}</Label>
            <Input
              id="disparo-nome"
              value={nome}
              maxLength={120}
              placeholder={t("Reativação de agosto")}
              onChange={(e) => setNome(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={criarDisparo} disabled={!nome.trim() || criar.isPending}>
              {t("Criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
