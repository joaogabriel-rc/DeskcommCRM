"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FormularioDeDefinicao } from "./FormularioDeDefinicao";
import { apiClient } from "@/lib/api/client";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

/**
 * As definições aprovadas do canal intermediado.
 *
 * ─── Por que esta tela não existia ─────────────────────────────────────────
 *
 * A aba "Templates da Meta" vive dentro do canal OFICIAL, e o endpoint dela
 * resolve a conexão por `metaSessionForOrg`. Numa instalação que só tem o canal
 * intermediado, o operador não tinha nem a aba nem a lista — e o seletor do
 * inbox dizia "nenhum modelo aprovado ainda" para uma conta cheia deles.
 *
 * O adapter já sabia listar, criar, editar e apagar desde que o canal entrou. O
 * que faltava era a porta.
 *
 * ─── Sincronizar é explícito, não automático ───────────────────────────────
 *
 * A lista mostra o ESPELHO — instantâneo, e é o que o resto do CRM lê. Puxar da
 * plataforma é um botão porque é chamada de rede que pode demorar, e porque
 * sincronizar sozinho ao abrir a tela esconderia a diferença entre "não tenho
 * nenhuma" e "não consegui perguntar".
 */
interface TemplateParceiro {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  syncedAt: string;
  components: unknown[];
}

const COR_DO_ESTADO: Record<string, string> = {
  APPROVED: "text-emerald-700 dark:text-emerald-400",
  PENDING: "text-amber-700 dark:text-amber-400",
  REJECTED: "text-destructive",
  PAUSED: "text-amber-700 dark:text-amber-400",
  DISABLED: "text-muted-foreground",
};

/**
 * Modelos do parceiro. `rota` permite reusar o MESMO componente para um segundo
 * parceiro Graph-compatível sem duplicar a tela — o default é a rota do parceiro
 * por credencial, e a aba nova passa a dela.
 */
export function TemplatesParceiroClient({
  rota = "/api/v1/channels/partner/templates",
}: { rota?: string } = {}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);
  // Trocar a `key` do formulário o devolve em branco depois de enviar.
  const [versao, setVersao] = useState(0);
  const [aberto, setAberto] = useState<string | null>(null);

  const lista = useQuery({
    queryKey: ["partner-templates", rota],
    queryFn: async () =>
      apiClient.get<{ data: { templates: TemplateParceiro[] } }>(rota),
  });

  const acao = useMutation({
    mutationFn: async (corpoReq: Record<string, unknown>) =>
      apiClient.post<{ data: { sincronizadas: number; total: number } }>(rota, corpoReq),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["partner-templates"] });
      // Invalida também o seletor do inbox: sem isto o operador sincroniza aqui,
      // volta à conversa e o seletor segue dizendo que não há nenhuma.
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
      toast.success(`${r.data.sincronizadas} ${t("de")} ${r.data.total} ${t("sincronizada(s).")}`);
      setCriando(false);
      setVersao((v) => v + 1);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? t(e.message) : t("Não consegui falar com a plataforma.")),
  });

  const templates = lista.data?.data.templates ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t(
            "O que a plataforma aprovou para este número. É daqui que sai a mensagem quando a janela de 24h fecha.",
          )}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => acao.mutate({ acao: "sincronizar" })}
            disabled={acao.isPending}
          >
            {acao.isPending ? t("Sincronizando…") : t("Sincronizar")}
          </Button>
          <Button type="button" size="sm" onClick={() => setCriando((v) => !v)}>
            {criando ? t("Cancelar") : t("Criar modelo")}
          </Button>
        </div>
      </div>

      {criando && (
        <FormularioDeDefinicao
          key={versao}
          enviando={acao.isPending}
          onEnviar={(rascunho) => acao.mutate({ acao: "criar", ...rascunho })}
        />
      )}

      {lista.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhum modelo espelhado ainda. Clique em")} <strong>{t("Sincronizar")}</strong>{" "}
          {t("para trazer os que já existem na plataforma.")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {templates.map((tpl) => {
            const chave = `${tpl.name}|${tpl.language}`;
            const c = lerConteudo(tpl.components);
            const expandido = aberto === chave;
            return (
              <li key={chave} className="px-3 py-2">
                {/* A linha inteira ABRE o conteúdo. Ver "APPROVED" sem ver o
                    texto obriga a abrir a plataforma para saber o que a
                    definição diz — e é o texto que decide qual mandar. */}
                <button
                  type="button"
                  onClick={() => setAberto(expandido ? null : chave)}
                  className="flex w-full flex-wrap items-center gap-2 text-left"
                  aria-expanded={expandido}
                >
                  <span className="font-mono text-sm">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground">{tpl.language}</span>
                  {tpl.category && (
                    <span className="rounded-md bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
                      {tpl.category}
                    </span>
                  )}
                  {c.variaveis > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {c.variaveis} {t("valor(es)")}
                    </span>
                  )}
                  <span
                    className={cn(
                      "ml-auto text-xs font-medium",
                      COR_DO_ESTADO[tpl.status?.toUpperCase()] ?? "text-muted-foreground",
                    )}
                  >
                    {tpl.status}
                  </span>
                </button>

                {/* O motivo da recusa é o que diz o que corrigir, e fica SEMPRE
                    à vista — não escondido atrás do clique: quem precisa dele
                    não sabe que precisa procurar. */}
                {tpl.rejectedReason && (
                  <p className="mt-1 text-[11px] text-destructive">{tpl.rejectedReason}</p>
                )}

                {expandido && (
                  <div className="mt-2 flex flex-col gap-1.5 rounded-md bg-muted/40 p-2 text-sm">
                    {c.header && (
                      <p className="text-xs">
                        <span className="text-muted-foreground">
                          {t("Cabeçalho")} ({c.header.formato}):{" "}
                        </span>
                        {c.header.texto ?? <em className="text-muted-foreground">{t("mídia")}</em>}
                      </p>
                    )}
                    {c.body ? (
                      <p className="whitespace-pre-wrap">{c.body}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("Sem corpo espelhado — sincronize para trazer o conteúdo.")}
                      </p>
                    )}
                    {c.footer && <p className="text-xs text-muted-foreground">{c.footer}</p>}
                    {c.botoes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {c.botoes.map((b, i) => (
                          <span key={i} className="rounded-md border border-border px-1.5 text-[11px]">
                            {b.texto} <span className="text-muted-foreground">({b.tipo})</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {t("Sincronizado em")} {new Date(tpl.syncedAt).toLocaleString(tagDoIdioma)}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
