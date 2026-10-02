"use client";

/**
 * O AVISO DO FLUXO PROTEGIDO (migration 0507) — o mesmo no construtor e no
 * disparo, para a pessoa ler a mesma coisa nos dois lugares.
 *
 * Diz POR QUE não dá para editar (histórico ou em uso, e quantos contatos estão
 * dentro) e oferece a saída: duplicar o disparo e editar a cópia, que nasce em
 * rascunho. Fluxo editável não mostra nada.
 */
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useDuplicarDisparo } from "@/hooks/disparos/useDisparos";
import { FRASE_DO_ESTADO, type UsoDoFluxo } from "@/lib/flows/uso";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { ClockCounterClockwise, Copy, Users } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export function AvisoDeFluxoProtegido({
  uso,
  broadcastId,
  className,
}: {
  uso: UsoDoFluxo | null | undefined;
  broadcastId: string;
  className?: string;
}) {
  const t = useT();
  const router = useRouter();
  const duplicar = useDuplicarDisparo(broadcastId);

  if (!uso || uso.escopo !== "disparo" || !uso.estado || uso.estado === "editavel") return null;
  const historico = uso.estado === "historico";

  async function aoDuplicar() {
    const r = await duplicar.mutateAsync();
    router.push(`/app/disparos/${r.broadcast_id}`);
  }

  return (
    <div
      role="status"
      data-testid="aviso-fluxo-protegido"
      data-estado={uso.estado}
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-md border px-3 py-2 text-sm",
        historico ? "border-border bg-muted/40" : "border-warning-fg/30 bg-warning-bg",
        className,
      )}
    >
      {historico ? (
        <ClockCounterClockwise size={18} aria-hidden className="mt-0.5 shrink-0 text-text-muted" />
      ) : (
        <Users size={18} aria-hidden className="mt-0.5 shrink-0 text-warning-fg" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium" data-testid="aviso-fluxo-protegido-titulo">
          {historico ? t("Definição histórica — somente leitura") : t("Fluxo em uso — somente leitura")}
        </p>
        <p className="text-text-muted">{t(FRASE_DO_ESTADO[uso.estado])}</p>
        {uso.vivas > 0 && (
          <p className="text-text-muted" data-testid="aviso-fluxo-protegido-vivas">
            {historico
              ? t("Ainda há contatos que podem responder aos botões deste fluxo:")
              : t("Contatos com o fluxo em execução agora:")}{" "}
            <strong>{uso.vivas}</strong>
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void aoDuplicar()}
        disabled={duplicar.isPending}
        data-testid="duplicar-disparo"
      >
        <Copy size={15} aria-hidden /> {duplicar.isPending ? t("Duplicando…") : t("Duplicar disparo")}
      </Button>
    </div>
  );
}
