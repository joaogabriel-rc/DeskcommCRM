"use client";

/**
 * O editor de um disparo: modo, público, mensagem (ou fluxo), agendamento e
 * andamento.
 *
 * ── Dois modos, um disparo ──────────────────────────────────────────────────
 *
 * GUIADO manda uma mensagem — o modelo aprovado vem do catálogo central, pelo
 * MESMO componente do nó de mensagem dos Fluxos (`ModeloDaMensagem`). FLUXO leva
 * cada contato por um fluxo próprio do disparo, editado no MESMO construtor das
 * automações (`/app/flows/[id]`) — este editor não desenha fluxo nenhum, só
 * abre o construtor.
 *
 * ── A prévia de público fica colada no construtor ───────────────────────────
 *
 * Porque a pergunta "quantas pessoas isso pega?" é a que decide se o filtro
 * está certo — e ela tem de ser respondida ENQUANTO se mexe no filtro. A tela
 * manda o segmento INTEIRO à prévia (o mesmo objeto que salva), e o servidor
 * devolve a contagem E a expressão lógica que calculou — é essa expressão que
 * aparece aqui, nunca uma descrição montada à parte.
 *
 * ── Por que editar exige pausar ─────────────────────────────────────────────
 *
 * Mesma regra do Flow. Trocar a mensagem no meio do envio faria metade do
 * público receber uma coisa e metade outra.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { InserirVariavel } from "@/components/catalogo/InserirVariavel";
import { SeletorDeCampo, SeletorDeTags, ValorDoCampo } from "@/components/catalogo/SeletorDeCampo";
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
import type { MessageNodeConfig } from "@/lib/flows/types";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { CaretLeft, Plus, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  OPERADORES_DE_CAMPO,
  OPERADOR_DE_CAMPO_LABEL,
  SEGMENTO_VAZIO,
  STATUS_DE_DISPARO_LABEL,
  porQueNaoPodeAgendar,
  temCriterioDePublico,
  type CriterioDeCampo,
  type MensagemDeDisparo,
  type ModoDeDisparo,
  type OperadorDeCampo,
  type Segmento,
} from "@/lib/schemas/disparos";
import { ModeloDaMensagem } from "../../../flows/[id]/_components/NodeConfigPanel";

type GrupoDeCampos = "fields" | "fields_any" | "fields_none";

export function DisparoEditor({ inicial }: { inicial: DisparoDetalhe }) {
  const t = useT();
  const router = useRouter();
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

  const modo: ModoDeDisparo = disparo.modo ?? (disparo.fluxo ? "fluxo" : "guiado");
  const editavel = disparo.status === "draft" || disparo.status === "paused";

  const temCriterio = temCriterioDePublico(segmento);
  const previa = usePreviaDePublico(segmento, temCriterio);
  const impedimento = useMemo(
    () => porQueNaoPodeAgendar({ segment: segmento, message: mensagem }, modo),
    [segmento, mensagem, modo],
  );

  function mudarSegmento(patch: Partial<Segmento>) {
    setSegmento((s) => ({ ...s, ...patch }));
  }
  function mudarMensagem(patch: Record<string, unknown>) {
    setMensagem((m) => ({ ...m, ...patch }) as MensagemDeDisparo);
  }

  async function salvarTudo() {
    await salvar.mutateAsync({
      name: nome.trim(),
      segment: segmento,
      message: mensagem,
      // `datetime-local` devolve hora local sem fuso; `new Date()` a interpreta
      // no fuso do navegador e `toISOString()` a normaliza para UTC, que é o que
      // a coluna `timestamptz` espera.
      scheduled_at: quando ? new Date(quando).toISOString() : null,
    });
  }

  async function trocarModo(novo: ModoDeDisparo) {
    if (novo === modo) return;
    await salvar.mutateAsync({ name: nome.trim(), segment: segmento, message: mensagem, modo: novo });
  }

  async function configurarFluxo() {
    // Salva antes de sair: o público e o nome não podem se perder na ida ao construtor.
    await salvarTudo();
    if (disparo.fluxo) router.push(`/app/flows/${disparo.fluxo.id}`);
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
            <p className="mt-1 flex gap-2 text-sm text-text-muted">
              <Badge variant="secondary">{t(STATUS_DE_DISPARO_LABEL[disparo.status])}</Badge>
              <Badge variant="outline" data-testid="modo-do-disparo">
                {modo === "fluxo" ? t("Modo fluxo") : t("Modo guiado")}
              </Badge>
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
            <Button
              onClick={agendar}
              disabled={!!impedimento || acao.isPending || salvar.isPending}
              data-testid="agendar-disparo"
            >
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
            <span className="text-xs tabular-nums text-text-muted" data-testid="andamento-do-disparo">
              {concluidos} {t("de")} {total} · {progresso}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-accent-500 transition-all" style={{ width: `${progresso}%` }} />
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-text-muted">
            <span>
              {disparo.sent_count} {modo === "fluxo" ? t("entraram no fluxo") : t("enviados")}
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
                  <span className="text-text-muted">{rotuloDoContato(p.contacts, t)}</span>
                  <span className="text-error-fg">{t(p.error ?? p.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ── Modo ───────────────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">{t("Como o disparo fala com o público")}</h2>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("Modo do disparo")}>
          {(["guiado", "fluxo"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={modo === m}
              disabled={disparo.status !== "draft" || salvar.isPending}
              onClick={() => void trocarModo(m)}
              data-testid={`modo-${m}`}
              className={cn(
                "rounded-md border border-border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70",
                modo === m ? "border-accent-500 bg-accent-soft" : "hover:border-accent-400",
              )}
            >
              <p className="font-medium">{m === "guiado" ? t("Guiado") : t("Fluxo")}</p>
              <p className="text-xs text-text-muted">
                {m === "guiado"
                  ? t("Uma mensagem para o público: escolha o modelo aqui mesmo.")
                  : t("Cada contato entra num fluxo próprio do disparo — mensagens, botões, esperas e condições.")}
              </p>
            </button>
          ))}
        </div>
        {disparo.status !== "draft" && (
          <p className="text-xs text-text-muted">{t("O modo só muda enquanto o disparo é rascunho.")}</p>
        )}
      </Card>

      {/* ── Público ────────────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("Público")}</h2>
          <span className="text-xs text-text-muted" data-testid="previa-do-publico">
            {!temCriterio
              ? t("Escolha ao menos um critério")
              : previa.isError
                ? t("Complete os critérios (campo e valor) para contar")
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

        {temCriterio && previa.data?.expressao && previa.data.expressao.length > 0 && (
          <div className="rounded-md bg-surface-elevated px-3 py-2 text-xs" data-testid="expressao-do-publico">
            <p className="mb-1 font-medium text-text-muted">{t("Quem entra")}</p>
            <ul className="flex flex-col gap-0.5 font-mono">
              {previa.data.expressao.map((linha, i) => (
                <li key={i}>
                  {i > 0 && <span className="text-text-muted">E </span>}
                  {linha}
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset disabled={!editavel} className="flex flex-col gap-4">
          <GrupoDoPublico
            titulo={t("Todas estas (E)")}
            ajuda={t("O contato precisa atender a TODAS as condições deste grupo.")}
            idDasTags="tags-all"
            tags={segmento.tags_all}
            onTags={(tags_all) => mudarSegmento({ tags_all })}
            campos={segmento.fields}
            onCampos={(fields) => mudarSegmento({ fields })}
            grupo="fields"
          />
          <GrupoDoPublico
            titulo={t("Pelo menos uma destas (OU)")}
            ajuda={t("Basta UMA das condições deste grupo.")}
            idDasTags="tags-any"
            tags={segmento.tags_any}
            onTags={(tags_any) => mudarSegmento({ tags_any })}
            campos={segmento.fields_any}
            onCampos={(fields_any) => mudarSegmento({ fields_any })}
            grupo="fields_any"
          />
          <GrupoDoPublico
            titulo={t("Nenhuma destas (NÃO)")}
            ajuda={t("Quem atender a QUALQUER condição deste grupo fica de fora.")}
            idDasTags="tags-none"
            tags={segmento.tags_none}
            onTags={(tags_none) => mudarSegmento({ tags_none })}
            campos={segmento.fields_none}
            onCampos={(fields_none) => mudarSegmento({ fields_none })}
            grupo="fields_none"
          />
        </fieldset>
      </Card>

      {/* ── Mensagem (guiado) ou Fluxo ─────────────────────────────────────── */}
      {modo === "guiado" ? (
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold">{t("Mensagem")}</h2>
          <fieldset disabled={!editavel} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t("Como enviar")}</Label>
              <Select
                value={mensagem.window_mode}
                onValueChange={(v) => mudarMensagem({ window_mode: v as MensagemDeDisparo["window_mode"] })}
              >
                <SelectTrigger aria-label={t("Como enviar")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="outside_24h">{t("Template aprovado (fora da janela de 24h)")}</SelectItem>
                  <SelectItem value="inside_24h">{t("Texto livre (só dentro da janela de 24h)")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mensagem.window_mode === "outside_24h" ? (
              // O MESMO seletor, a mesma prévia e os mesmos espaços do nó de
              // mensagem dos Fluxos — o catálogo central da Rodada 1.
              <ModeloDaMensagem config={mensagem as unknown as MessageNodeConfig} patch={mudarMensagem} />
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
      ) : (
        <Card className="flex flex-col gap-3 p-4" data-testid="cartao-do-fluxo">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("Fluxo do disparo")}</h2>
            {disparo.fluxo && (
              <Badge variant="secondary">
                {disparo.fluxo.status === "active" ? t("Ligado com o agendamento") : t("Rascunho")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-text-muted">
            {t(
              "Monte aqui o que cada contato recebe: o primeiro passo costuma ser a mensagem com o modelo aprovado, e dali saem os caminhos dos botões, esperas e condições. Este fluxo é só deste disparo — não aparece em Automações.",
            )}
          </p>
          <div>
            <Button onClick={() => void configurarFluxo()} disabled={!disparo.fluxo || salvar.isPending} data-testid="configurar-fluxo">
              {disparo.status === "draft" ? t("Configurar fluxo") : t("Ver fluxo")}
            </Button>
          </div>
        </Card>
      )}

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
}

/**
 * Um grupo do público: etiquetas (chips do registro) + critérios de campo
 * (campo do registro, operador, valor no controle do tipo). O grupo não sabe se
 * é E, OU ou NÃO — quem dá o sentido é o lugar do segmento em que ele grava.
 */
function GrupoDoPublico({
  titulo,
  ajuda,
  idDasTags,
  tags,
  onTags,
  campos,
  onCampos,
  grupo,
}: {
  titulo: string;
  ajuda: string;
  idDasTags: string;
  tags: string[];
  onTags: (tags: string[]) => void;
  campos: CriterioDeCampo[];
  onCampos: (campos: CriterioDeCampo[]) => void;
  grupo: GrupoDeCampos;
}) {
  const t = useT();

  function trocar(indice: number, patch: Partial<CriterioDeCampo>) {
    const atual = campos[indice];
    if (!atual) return;
    const proximo = [...campos];
    proximo[indice] = { ...atual, ...patch };
    onCampos(proximo);
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid={`grupo-${grupo}`}>
      <div>
        <h3 className="text-sm font-medium">{titulo}</h3>
        <p className="text-xs text-text-muted">{ajuda}</p>
      </div>
      <Label className="text-xs text-text-muted">{t("Etiquetas")}</Label>
      <SeletorDeTags id={idDasTags} valor={tags} onChange={onTags} permitirNova={false} />

      <Label className="mt-1 text-xs text-text-muted">{t("Campos do usuário")}</Label>
      {campos.map((criterio, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
          <div className="min-w-40 flex-1">
            <SeletorDeCampo valor={criterio.key} onChange={(key) => trocar(i, { key })} />
          </div>
          <Select value={criterio.op} onValueChange={(op) => trocar(i, { op: op as OperadorDeCampo })}>
            <SelectTrigger className="w-44" aria-label={t("Operador")}>
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
          {/* "está preenchido" e "está vazio" não têm valor para comparar. */}
          {criterio.op !== "set" && criterio.op !== "unset" && (
            <ValorDoCampo chave={criterio.key} valor={criterio.value} onChange={(value) => trocar(i, { value })} />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("Remover critério")}
            onClick={() => onCampos(campos.filter((_, j) => j !== i))}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onCampos([...campos, { key: "", op: "eq", value: "" }])}
          data-testid={`adicionar-criterio-${grupo}`}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar critério de campo")}
        </Button>
      </div>
    </section>
  );
}
