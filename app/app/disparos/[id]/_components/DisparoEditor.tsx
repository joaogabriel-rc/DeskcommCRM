"use client";

/**
 * O editor de um disparo: público, mensagem, agendamento e andamento.
 *
 * ── A prévia de público fica colada no construtor ───────────────────────────
 *
 * Porque a pergunta "quantas pessoas isso pega?" é a que decide se o filtro
 * está certo — e ela tem de ser respondida ENQUANTO se mexe no filtro, não
 * depois de agendar. O número vem da MESMA função de segmentação que o
 * agendamento usa (`lib/disparos/segmento.ts`), então não há prévia otimista:
 * o que ela diz é o que vai sair.
 *
 * ── Por que editar exige pausar ─────────────────────────────────────────────
 *
 * Mesma regra do Flow. Trocar a mensagem no meio do envio faria metade do
 * público receber uma coisa e metade outra, com o mesmo nome na lista e nenhum
 * jeito de saber depois quem recebeu qual.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { InserirVariavel } from "@/components/catalogo/InserirVariavel";
import { SeletorDeCampo, SeletorDeTags } from "@/components/catalogo/SeletorDeCampo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useAcaoDeDisparo,
  useDisparo,
  usePreviaDePublico,
  useSalvarDisparo,
  type DisparoDetalhe,
} from "@/hooks/disparos/useDisparos";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { proximoSlot, renomearSlot } from "@/lib/flows/slots";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { CaretLeft, Plus, X } from "@/lib/ui/icons";
import {
  OPERADORES_DE_CAMPO,
  OPERADOR_DE_CAMPO_LABEL,
  SEGMENTO_VAZIO,
  STATUS_DE_DISPARO_LABEL,
  porQueNaoPodeAgendar,
  type CriterioDeCampo,
  type MensagemDeDisparo,
  type OperadorDeCampo,
  type Segmento,
} from "@/lib/schemas/disparos";

export function DisparoEditor({ inicial }: { inicial: DisparoDetalhe }) {
  const t = useT();
  const emAndamento = inicial.status === "running" || inicial.status === "scheduled";
  const { data: disparo = inicial } = useDisparo(inicial.id, {
    initialData: inicial,
    emAndamento,
  });
  const salvar = useSalvarDisparo(inicial.id);
  const acao = useAcaoDeDisparo(inicial.id);

  const [nome, setNome] = useState(disparo.name);
  const [segmento, setSegmento] = useState<Segmento>({
    ...SEGMENTO_VAZIO,
    ...(disparo.segment ?? {}),
  });
  // Os defaults vêm DEPOIS do que está gravado, com `??` campo a campo: um
  // spread do gravado por cima de um objeto de defaults sobrescreveria o modo
  // salvo por `undefined` quando a coluna tivesse a chave ausente.
  const [mensagem, setMensagem] = useState<MensagemDeDisparo>({
    ...(disparo.message ?? {}),
    window_mode: disparo.message?.window_mode ?? "outside_24h",
    body: disparo.message?.body ?? "",
    template_values: disparo.message?.template_values ?? {},
  });
  const [quando, setQuando] = useState(
    disparo.scheduled_at ? disparo.scheduled_at.slice(0, 16) : "",
  );

  const editavel = disparo.status === "draft" || disparo.status === "paused";

  const temCriterio =
    segmento.tags_all.length + segmento.tags_any.length + segmento.fields.length > 0;
  const previa = usePreviaDePublico(segmento, temCriterio);
  const impedimento = useMemo(
    () => porQueNaoPodeAgendar({ segment: segmento, message: mensagem }),
    [segmento, mensagem],
  );

  function mudarSegmento(patch: Partial<Segmento>) {
    setSegmento((s) => ({ ...s, ...patch }));
  }
  function mudarMensagem(patch: Partial<MensagemDeDisparo>) {
    setMensagem((m) => ({ ...m, ...patch }));
  }

  async function salvarTudo() {
    await salvar.mutateAsync({
      name: nome.trim(),
      segment: segmento,
      message: mensagem,
      // `datetime-local` devolve hora local sem fuso; `new Date()` a interpreta
      // no fuso do navegador e `toISOString()` a normaliza para UTC, que é o que
      // a coluna `timestamptz` espera. Mandar a string crua gravaria o horário
      // certo com o fuso errado.
      scheduled_at: quando ? new Date(quando).toISOString() : null,
    });
  }

  async function agendar() {
    await salvarTudo();
    await acao.mutateAsync("agendar");
  }

  const total = disparo.total_recipients || 0;
  const concluidos = disparo.sent_count + disparo.failed_count + disparo.skipped_count;
  const progresso = total > 0 ? Math.round((concluidos / total) * 100) : 0;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button asChild variant="ghost" size="icon" aria-label={t("Voltar para os disparos")}>
            <Link href="/app/disparos">
              <CaretLeft size={18} aria-hidden />
            </Link>
          </Button>
          <div>
            {editavel ? (
              <Input
                value={nome}
                maxLength={120}
                onChange={(e) => setNome(e.target.value)}
                className="h-9 text-lg font-semibold"
                aria-label={t("Nome do disparo")}
              />
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight">{disparo.name}</h1>
            )}
            <p className="mt-1 text-sm text-text-muted">
              <Badge variant="secondary">{t(STATUS_DE_DISPARO_LABEL[disparo.status])}</Badge>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editavel && (
            <Button variant="outline" onClick={salvarTudo} disabled={salvar.isPending}>
              {t("Salvar rascunho")}
            </Button>
          )}
          {editavel && (
            <Button onClick={agendar} disabled={!!impedimento || acao.isPending || salvar.isPending}>
              {disparo.status === "paused" ? t("Reagendar") : t("Agendar envio")}
            </Button>
          )}
          {(disparo.status === "running" || disparo.status === "scheduled") && (
            <Button variant="outline" onClick={() => acao.mutate("pausar")}>
              {t("Pausar")}
            </Button>
          )}
          {disparo.status === "paused" && (
            <Button variant="outline" onClick={() => acao.mutate("retomar")}>
              {t("Retomar")}
            </Button>
          )}
          {disparo.status !== "completed" && disparo.status !== "cancelled" && (
            <Button variant="ghost" onClick={() => acao.mutate("cancelar")}>
              {t("Cancelar")}
            </Button>
          )}
        </div>
      </header>

      {impedimento && editavel && (
        <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          {t(impedimento)}
        </p>
      )}

      {/* ── Andamento ──────────────────────────────────────────────────────── */}
      {total > 0 && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("Andamento")}</h2>
            <span className="text-xs tabular-nums text-text-muted">
              {/* Número fora do `t()`: frase montada em runtime nunca casa
                  chave nenhuma no dicionário. */}
              {concluidos} {t("de")} {total} · {progresso}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-accent-500 transition-all" style={{ width: `${progresso}%` }} />
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-text-muted">
            <span>
              {disparo.sent_count} {t("enviados")}
            </span>
            <span>
              {disparo.failed_count} {t("falharam")}
            </span>
            <span>
              {disparo.skipped_count} {t("pulados")}
            </span>
            {disparo.last_error && <span className="text-error-fg">{disparo.last_error}</span>}
          </div>
          {disparo.problemas.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
              {disparo.problemas.map((p) => (
                <li key={p.id} className="flex flex-wrap gap-2">
                  <span className="text-text-muted">
                    {rotuloDoContato(p.contacts, t)}
                  </span>
                  <span className="text-error-fg">{t(p.error ?? p.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ── Público ────────────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("Público")}</h2>
          <span className="text-xs text-text-muted">
            {!temCriterio
              ? t("Escolha ao menos um critério")
              : previa.isLoading
                ? t("Contando…")
                : `${previa.data?.total ?? 0} ${t("contato(s) agora")}`}
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {t(
            "Contatos bloqueados, anonimizados, mesclados ou sem telefone nunca entram — isso não é um filtro que dê para desligar.",
          )}
        </p>

        <fieldset disabled={!editavel} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t("Tem TODAS estas tags")}</Label>
            <SeletorDeTags
              id="tags-all"
              valor={segmento.tags_all}
              onChange={(tags_all) => mudarSegmento({ tags_all })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("Tem ao menos UMA destas tags")}</Label>
            <SeletorDeTags
              id="tags-any"
              valor={segmento.tags_any}
              onChange={(tags_any) => mudarSegmento({ tags_any })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("NÃO tem nenhuma destas tags")}</Label>
            <SeletorDeTags
              id="tags-none"
              valor={segmento.tags_none}
              onChange={(tags_none) => mudarSegmento({ tags_none })}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t("Campos do usuário")}</Label>
            {segmento.fields.map((criterio, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
                <div className="min-w-40 flex-1">
                  <SeletorDeCampo
                    valor={criterio.key}
                    onChange={(key) => trocarCriterio(i, { key })}
                  />
                </div>
                <Select
                  value={criterio.op}
                  onValueChange={(op) => trocarCriterio(i, { op: op as OperadorDeCampo })}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERADORES_DE_CAMPO.map((op) => (
                      <SelectItem key={op} value={op}>
                        {t(OPERADOR_DE_CAMPO_LABEL[op])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* "está preenchido" e "está vazio" não têm valor para comparar —
                    mostrar o campo seria oferecer um controle sem efeito. */}
                {criterio.op !== "set" && criterio.op !== "unset" && (
                  <Input
                    className="w-44"
                    value={criterio.value}
                    placeholder={t("valor")}
                    onChange={(e) => trocarCriterio(i, { value: e.target.value })}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("Remover critério")}
                  onClick={() =>
                    mudarSegmento({ fields: segmento.fields.filter((_, j) => j !== i) })
                  }
                >
                  <X size={14} aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                mudarSegmento({ fields: [...segmento.fields, { key: "", op: "eq", value: "" }] })
              }
            >
              <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar critério de campo")}
            </Button>
          </div>
        </fieldset>
      </Card>

      {/* ── Mensagem ───────────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold">{t("Mensagem")}</h2>
        <fieldset disabled={!editavel} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t("Como enviar")}</Label>
            <Select
              value={mensagem.window_mode}
              onValueChange={(v) => mudarMensagem({ window_mode: v as MensagemDeDisparo["window_mode"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outside_24h">{t("Template aprovado (fora da janela de 24h)")}</SelectItem>
                <SelectItem value="inside_24h">{t("Texto livre (só dentro da janela de 24h)")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {mensagem.window_mode === "outside_24h"
                ? t(
                    "É o modo certo para campanha: fora da janela de 24 horas a plataforma só aceita template aprovado, pelo canal oficial.",
                  )
                : t(
                    "Texto livre só chega a quem falou com você nas últimas 24 horas. Para os demais, o envio falha — a plataforma recusa.",
                  )}
            </p>
          </div>

          {mensagem.window_mode === "outside_24h" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="template-nome">{t("Nome do template aprovado")}</Label>
                <Input
                  id="template-nome"
                  value={mensagem.template_name ?? ""}
                  placeholder="reativacao_agosto"
                  onChange={(e) => mudarMensagem({ template_name: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="template-idioma">{t("Idioma do template")}</Label>
                <Input
                  id="template-idioma"
                  value={mensagem.template_language ?? ""}
                  placeholder="pt_BR"
                  onChange={(e) => mudarMensagem({ template_language: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>{t("Valores dos espaços do template")}</Label>
                {Object.entries(mensagem.template_values ?? {}).map(([slot, valor]) => (
                  <div key={slot} className="flex items-center gap-2">
                    <Input
                      className="w-24 shrink-0 font-mono text-xs"
                      value={slot}
                      aria-label={t("Espaço do template")}
                      onChange={(e) =>
                        mudarMensagem({
                          template_values: renomearSlot(
                            mensagem.template_values ?? {},
                            slot,
                            e.target.value,
                          ),
                        })
                      }
                    />
                    <Input
                      value={valor}
                      onChange={(e) =>
                        mudarMensagem({
                          template_values: { ...mensagem.template_values, [slot]: e.target.value },
                        })
                      }
                    />
                    <InserirVariavel
                      onInserir={(v) =>
                        mudarMensagem({
                          template_values: { ...mensagem.template_values, [slot]: `${valor}${v}` },
                        })
                      }
                    />
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    mudarMensagem({
                      template_values: {
                        ...mensagem.template_values,
                        [proximoSlot(mensagem.template_values ?? {})]: "",
                      },
                    })
                  }
                >
                  <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar espaço")}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="disparo-texto">{t("Texto")}</Label>
              <Textarea
                id="disparo-texto"
                rows={5}
                value={mensagem.body}
                onChange={(e) => mudarMensagem({ body: e.target.value })}
              />
              <div className="flex justify-end">
                <InserirVariavel onInserir={(v) => mudarMensagem({ body: `${mensagem.body}${v}` })} />
              </div>
            </div>
          )}
        </fieldset>
      </Card>

      {/* ── Agendamento ────────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">{t("Quando")}</h2>
        <fieldset disabled={!editavel} className="flex flex-col gap-1.5">
          <Label htmlFor="disparo-quando">{t("Começar em (vazio = assim que agendar)")}</Label>
          <Input
            id="disparo-quando"
            type="datetime-local"
            className="w-64"
            value={quando}
            onChange={(e) => setQuando(e.target.value)}
          />
          <p className="text-xs text-text-muted">
            {t(
              "O envio sai aos poucos, cerca de uma mensagem a cada cinco segundos, para proteger o número. Um público de 600 pessoas leva cerca de 50 minutos.",
            )}
          </p>
        </fieldset>
      </Card>
    </div>
  );

  function trocarCriterio(indice: number, patch: Partial<CriterioDeCampo>) {
    const atual = segmento.fields[indice];
    if (!atual) return;
    const fields = [...segmento.fields];
    fields[indice] = { ...atual, ...patch };
    mudarSegmento({ fields });
  }
}
