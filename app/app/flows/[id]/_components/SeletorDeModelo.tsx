"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCatalogoDeModelos } from "@/hooks/channels/useCatalogoDeModelos";
import type { ModeloDoCatalogo } from "@/lib/channels/catalogo-de-modelos";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conexão já fixada no nó, se houver. */
  conexaoAtual?: string;
  modeloAtual?: string;
  onEscolher: (modelo: ModeloDoCatalogo, conexaoId: string | null) => void;
}

/**
 * "Escolher modelo" — a lista vem do CATÁLOGO central, e só aparece o que a
 * plataforma entrega (aprovado). O operador nunca digita nome nem idioma: o que
 * ele escolhe é uma linha real do espelho, e é o id dela que o nó guarda.
 *
 * Com mais de um número com catálogo, a conexão é escolhida primeiro: o modelo é
 * aprovado POR CONTA, e oferecer o de outra conta produziria um envio que a
 * plataforma recusa.
 */
export function SeletorDeModelo({ open, onOpenChange, conexaoAtual, modeloAtual, onEscolher }: Props) {
  const t = useT();
  const catalogo = useCatalogoDeModelos({ todos: true, enabled: open });
  const [busca, setBusca] = useState("");
  const [conexaoEscolhida, setConexaoEscolhida] = useState<string | undefined>(conexaoAtual);

  const conexoes = useMemo(() => catalogo.data?.conexoes ?? [], [catalogo.data]);
  const conexaoId = conexaoEscolhida ?? (conexoes.length === 1 ? conexoes[0]!.id : undefined);
  const conexao = conexoes.find((c) => c.id === conexaoId);

  const termo = busca.trim().toLowerCase();
  const visiveis = (catalogo.data?.modelos ?? []).filter((m) => {
    if (!m.utilizavel) return false;
    if (conexao) {
      const daConexao =
        m.channelSessionId === conexao.id ||
        (m.channelSessionId === null && !!conexao.wabaId && m.wabaId === conexao.wabaId);
      if (!daConexao) return false;
    }
    if (!termo) return true;
    return (
      m.name.toLowerCase().includes(termo) ||
      m.language.toLowerCase().includes(termo) ||
      (m.category ?? "").toLowerCase().includes(termo)
    );
  });

  const precisaEscolherConexao = conexoes.length > 1 && !conexao;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Escolher modelo de mensagem")}</DialogTitle>
          <DialogDescription>
            {t("Só aparecem os modelos aprovados pela plataforma. O texto, os espaços e os botões vêm do próprio modelo.")}
          </DialogDescription>
        </DialogHeader>

        {conexoes.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-text-muted">{t("Número que envia")}</span>
            <Select value={conexaoId} onValueChange={setConexaoEscolhida}>
              <SelectTrigger aria-label={t("Número que envia")}>
                <SelectValue placeholder={t("Escolha o número")} />
              </SelectTrigger>
              <SelectContent>
                {conexoes.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.rotulo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Pesquise por nome, idioma ou categoria")}
          aria-label={t("Pesquisar modelo")}
          disabled={precisaEscolherConexao}
        />

        <div className="max-h-[55vh] overflow-y-auto pr-1" data-testid="seletor-de-modelo-lista">
          {catalogo.isLoading && <p className="p-3 text-sm text-text-muted">{t("Carregando modelos…")}</p>}
          {catalogo.isError && (
            <p className="p-3 text-sm text-error-fg">{t("Não foi possível carregar os modelos. Tente de novo.")}</p>
          )}
          {catalogo.data && conexoes.length === 0 && (
            <div className="flex flex-col gap-2 p-3 text-sm text-text-muted">
              <p>{t("Nenhum número oficial conectado. Modelo aprovado só existe no canal oficial.")}</p>
              <Link href="/app/connections" className="text-accent underline-offset-2 hover:underline">
                {t("Ir para Conexões")}
              </Link>
            </div>
          )}
          {precisaEscolherConexao && (
            <p className="p-3 text-sm text-text-muted">{t("Escolha o número que envia para ver os modelos dele.")}</p>
          )}
          {catalogo.data && conexoes.length > 0 && !precisaEscolherConexao && visiveis.length === 0 && (
            <div className="flex flex-col gap-2 p-3 text-sm text-text-muted">
              <p>
                {termo
                  ? t("Nenhum modelo aprovado com esse nome.")
                  : t("Nenhum modelo aprovado neste número. Sincronize os modelos em Conexões › API Oficial › Templates.")}
              </p>
              {!termo && (
                <Link href="/app/connections" className="text-accent underline-offset-2 hover:underline">
                  {t("Ir para Conexões")}
                </Link>
              )}
            </div>
          )}

          <ul className="flex flex-col gap-1">
            {!precisaEscolherConexao &&
              visiveis.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onEscolher(m, conexaoId ?? null);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "w-full rounded-md border border-border p-3 text-left transition-colors hover:border-accent-400",
                      m.id === modeloAtual && "border-accent-500 bg-accent-soft",
                    )}
                    data-testid={`modelo-${m.name}-${m.language}`}
                  >
                    <p className="font-medium">{m.name}</p>
                    <p className="text-xs text-text-muted">
                      {[m.category, m.language, m.espacos.length ? `${m.espacos.length} ${t("espaço(s)")}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {m.conteudo.body && (
                      <p className="mt-1 line-clamp-2 text-xs text-text-muted">{m.conteudo.body}</p>
                    )}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
