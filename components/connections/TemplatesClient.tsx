"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  useCriarModelo,
  useSaveTemplateValues,
  useSyncTemplates,
  useTemplates,
  type ConexaoOficial,
  type TemplatePreview,
  type TemplateSlotView,
  type TemplateView,
} from "@/hooks/channels/useTemplates";
import { useT } from "@/hooks/i18n/useT";

import { FormularioDeDefinicao } from "./FormularioDeDefinicao";

/** Só APPROVED pode ser disparado — o resto é informação, não opção. */
function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED" || status === "DISABLED") return "destructive";
  if (status === "PENDING") return "secondary";
  return "outline";
}

/**
 * O preview é a peça central desta tela. A Meta **não devolve** valores de exemplo
 * (`example` vem null nos templates reais), então o único jeito de o operador saber
 * o que preencher é ver o texto ao redor do parâmetro.
 *
 * O texto aparece INTEIRO e uma vez só, com todos os `{{n}}` marcados. A versão
 * anterior repetia o corpo a cada slot — cada linha destacava o seu e deixava o
 * vizinho cru, o que é tecnicamente correto e ilegível.
 */
function Preview({ preview }: { preview: TemplatePreview }) {
  const t = useT();
  const partes = preview.text.split(/(\{\{\w+\}\})/g);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {t(preview.onde)}
      </span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {partes.map((parte, i) =>
          /^\{\{\w+\}\}$/.test(parte) ? (
            <span
              key={i}
              className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary ring-1 ring-primary/20"
            >
              {parte.slice(2, -2)}
            </span>
          ) : (
            <span key={i} className="text-muted-foreground">
              {parte}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

/**
 * Criar um modelo na conta de uma conexão oficial — o MESMO formulário dos
 * parceiros, sem o cabeçalho de mídia (ver `lib/channels/meta/templates.ts`).
 * O modelo volta PENDENTE e fica visível na lista abaixo com esse estado.
 */
function CriarModeloOficial({ conexoes, aoCriar }: { conexoes: ConexaoOficial[]; aoCriar: () => void }) {
  const t = useT();
  const criar = useCriarModelo();
  const [conexao, setConexao] = useState(conexoes.length === 1 ? conexoes[0]!.id : "");
  const [versao, setVersao] = useState(0);

  return (
    <FormularioDeDefinicao
      key={versao}
      idiomaInicial="pt_BR"
      permiteMidia={false}
      enviando={criar.isPending}
      podeEnviar={!!conexao}
      onEnviar={async (rascunho) => {
        const r = await criar.mutateAsync({ channel_session_id: conexao, ...rascunho }).catch(() => null);
        if (!r) return;
        toast.success(
          `${t("Modelo enviado para a Meta:")} ${r.data.modelo.name} — ${r.data.modelo.status}. ${t("Ele só pode ser usado depois de aprovado.")}`,
        );
        setVersao((v) => v + 1);
        aoCriar();
      }}
    >
      <select
        value={conexao}
        onChange={(e) => setConexao(e.target.value)}
        aria-label={t("Conexão")}
        data-testid="criar-modelo-conexao"
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        {conexoes.length !== 1 && <option value="">{t("Escolha o número oficial")}</option>}
        {conexoes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.rotulo}
            {c.wabaId ? ` · ${c.wabaId}` : ""}
          </option>
        ))}
      </select>
    </FormularioDeDefinicao>
  );
}

function ehMidia(s: TemplateSlotView): boolean {
  return s.expects === "image" || s.expects === "video" || s.expects === "document";
}

/**
 * O link da mídia do cabeçalho, salvo NO MODELO e não no disparo.
 *
 * A plataforma exige o link em todo envio de modelo com cabeçalho de mídia — o
 * arquivo enviado na aprovação é só amostra. Até aqui a única porta para salvar
 * era o painel da janela fechada, que só grava DEPOIS de um envio: para deixar o
 * modelo pronto, o operador tinha de disparar para um cliente. Aqui ele salva
 * sem enviar nada, na mesma tela em que sincroniza. Campo vazio esquece o link.
 */
function LinkDaMidia({ tpl, slot }: { tpl: TemplateView; slot: TemplateSlotView }) {
  const t = useT();
  const salvar = useSaveTemplateValues();
  const salvo = tpl.savedValues[slot.valueKey] ?? "";
  const [valor, setValor] = useState(salvo);
  const limpo = valor.trim();
  // A plataforma só baixa `https://` com host; a rota recusa o resto com um
  // código (`link_invalido`) que chegaria cru ao aviso. Dizer antes, no campo.
  const linkInvalido = limpo !== "" && !/^https:\/\/[^\s/]+/i.test(limpo);
  const id = `link:${tpl.name}:${tpl.language}:${slot.valueKey}`;

  async function gravar() {
    await salvar.mutateAsync({
      name: tpl.name,
      language: tpl.language,
      values: { [slot.valueKey]: limpo },
    });
    toast.success(limpo ? t("Link salvo no modelo.") : t("Link removido do modelo."));
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs uppercase tracking-wide text-muted-foreground">
        {t(slot.onde)} · {slot.expects}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          disabled={salvar.isPending}
          data-testid="template-link-midia"
        />
        <Button
          variant="outline"
          onClick={gravar}
          disabled={limpo === salvo || linkInvalido || salvar.isPending}
          data-testid="btn-salvar-link"
        >
          {salvar.isPending
            ? t("Salvando…")
            : !limpo && salvo
              ? t("Remover link")
              : t("Salvar link")}
        </Button>
      </div>
      {linkInvalido ? (
        <span className="text-xs text-destructive" role="status">
          {t("Use um link público que comece com https://")}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {salvo
            ? t("Link salvo: o painel do modelo na conversa já vem preenchido com ele.")
            : t("Link público (https) do arquivo. Salvo aqui, o painel do modelo na conversa já vem preenchido.")}
        </span>
      )}
    </div>
  );
}

export function TemplatesClient() {
  const t = useT();
  const { data, isPending } = useTemplates();
  const sync = useSyncTemplates();
  const [criando, setCriando] = useState(false);
  const conexoes = data?.data.conexoes ?? [];

  const waba = data?.data.waba ?? null;
  const templates = data?.data.templates ?? null;

  async function sincronizar() {
    const res = await sync.mutateAsync();
    const { inserted, updated, disabled } = res.data;
    toast.success(
      `${t("Sincronizado:")} ${inserted} ${t("novo(s),")} ${updated} ${t("atualizado(s),")} ${disabled} ${t("desativado(s).")}`,
    );
  }

  if (isPending || templates === null) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  // Estado vazio que ENSINA — distinguir "canal não conectado" de "conectado sem
  // template" é a diferença entre o operador saber o próximo passo ou não.
  if (!waba) {
    return (
      <Card className="p-6">
        <h2 className="font-medium">{t("Canal oficial não conectado")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os templates vivem na sua conta do WhatsApp Business (Meta) — esta tela é um espelho deles. Conecte o canal oficial em")}{" "}
          <strong>{t("Conexões WhatsApp")}</strong> {t("para começar a sincronizar.")}
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="templates-root">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t("Espelho da conta")} <span className="font-mono text-xs">{waba}</span> ·{" "}
          {templates.length} {t("template(s)")}
        </p>
        <div className="flex gap-2">
          <Button onClick={sincronizar} disabled={sync.isPending} data-testid="btn-sync" variant="outline">
            {sync.isPending ? t("Sincronizando…") : t("Sincronizar com a Meta")}
          </Button>
          {conexoes.length > 0 && (
            <Button onClick={() => setCriando((v) => !v)} data-testid="btn-criar-modelo">
              {criando ? t("Cancelar") : t("Criar modelo")}
            </Button>
          )}
        </div>
      </div>

      {criando && <CriarModeloOficial conexoes={conexoes} aoCriar={() => setCriando(false)} />}

      {templates.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">{t("Nenhum template ainda")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Crie um modelo em Criar modelo, acima, ou no Gerenciador do WhatsApp e clique em")}{" "}
            <strong>{t("Sincronizar com a Meta")}</strong>.{" "}
            {t("Só templates aprovados podem ser enviados fora da janela de 24 horas.")}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <Card key={`${tpl.name}:${tpl.language}`} className="p-4" data-testid="template-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tpl.name}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {tpl.language}
                </Badge>
                <Badge variant={statusTone(tpl.status)}>{tpl.status}</Badge>
                {tpl.category ? (
                  <Badge variant="outline" className="text-xs">
                    {tpl.category}
                  </Badge>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {tpl.slots.length === 0
                    ? t("sem parâmetros")
                    : `${tpl.slots.length} ${t("parâmetro(s)")}`}
                </span>
              </div>

              {tpl.rejectedReason ? (
                <p className="mt-2 text-sm text-destructive">
                  {t("Recusado:")} {tpl.rejectedReason}
                </p>
              ) : null}

              {tpl.previews.length > 0 || tpl.slots.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3 border-l-2 border-muted pl-3">
                  {tpl.previews.map((p, i) => (
                    <Preview key={`${p.onde}:${i}`} preview={p} />
                  ))}
                  {/* Slots SEM texto ao redor: header de mídia. É justamente o
                      parâmetro que contar `{{n}}` não enxerga. */}
                  {tpl.slots
                    .filter((s) => s.expects !== "text")
                    .map((s, i) =>
                      ehMidia(s) ? (
                        // `salvo` na chave: o campo nasce do link salvo e não o
                        // acompanha depois. Se o link mudar por outra porta (o
                        // painel da conversa), o refetch remonta o campo em vez
                        // de deixar o valor velho pronto para ser gravado de volta.
                        <LinkDaMidia
                          key={`m:${s.valueKey}:${tpl.savedValues[s.valueKey] ?? ""}`}
                          tpl={tpl}
                          slot={s}
                        />
                      ) : (
                        <div key={`m:${s.onde}:${i}`} className="flex flex-col gap-0.5">
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">
                            {t(s.onde)} · {s.expects}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {t("arquivo de")} {s.expects} {t("enviado no disparo")}
                          </span>
                        </div>
                      ),
                    )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
