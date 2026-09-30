"use client";

/**
 * O editor de um disparo, em SEÇÕES que abrem e fecham (acordeão), na ordem em
 * que a decisão acontece: CONTEÚDO (o quê — a mensagem, ou o construtor de
 * fluxos), PÚBLICO-ALVO (quem) e ENVIO (quando). O andamento aparece em cima
 * quando o disparo já saiu.
 *
 * ── Dois modos, um disparo ──────────────────────────────────────────────────
 *
 * MENSAGEM (guiado) manda um modelo aprovado — escolhido do catálogo central,
 * pelo MESMO componente do nó de mensagem dos Fluxos (`ModeloDaMensagem`).
 * CONSTRUTOR DE FLUXOS leva cada contato por um fluxo próprio do disparo,
 * editado no MESMO construtor das automações. "Ir para o Construtor de Fluxos"
 * cria esse fluxo UMA vez (a rota reaproveita o que existir) e salva nome,
 * público e envio antes de sair — nada se perde na ida e na volta.
 *
 * ── O público é uma lista de CONDIÇÕES em três grupos ───────────────────────
 *
 * A semântica é a de sempre (`lib/disparos/segmento.ts`): TODAS (E), PELO MENOS
 * UMA (OU) e NENHUMA (NÃO, a exclusão). O que mudou é como se escolhe: "+
 * Condição" abre um menu com busca e três categorias — Filtros gerais (tag),
 * Campos do sistema e Campos personalizados. O seletor antigo era um `Select`
 * que lia só o registro de etiquetas: numa organização com etiquetas apenas
 * aplicadas, abria vazio, como uma barra fina fora do lugar.
 *
 * ── A prévia fica ao lado das condições ─────────────────────────────────────
 *
 * "Quantas pessoas isso pega?" é a pergunta que decide se o filtro está certo,
 * e é respondida enquanto se mexe nele — só CONTANDO (`/broadcasts/previa`),
 * nunca executando o disparo.
 *
 * ── Por que editar exige pausar ─────────────────────────────────────────────
 *
 * Mesma regra do Flow. Trocar a mensagem no meio do envio faria metade do
 * público receber uma coisa e metade outra.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { InserirVariavel } from "@/components/catalogo/InserirVariavel";
import { ValorDoCampo } from "@/components/catalogo/SeletorDeCampo";
import { CriarModeloOficial } from "@/components/connections/TemplatesClient";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useCamposDoContato } from "@/hooks/catalogo/useCatalogo";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useOpcoesDeEtiqueta } from "@/hooks/catalogo/useOpcoesDeEtiqueta";
import { useTemplates } from "@/hooks/channels/useTemplates";
import {
  useAcaoDeDisparo,
  useDisparo,
  usePreviaDePublico,
  useSalvarDisparo,
  type DisparoDetalhe,
} from "@/hooks/disparos/useDisparos";
import { roleAtLeast } from "@/lib/auth/types";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  fusoDoAgendamento,
  instanteDoAgendamento,
  paredeDoAgendamento,
  problemaDoAgendamento,
} from "@/lib/disparos/agendamento";
import type { MessageNodeConfig } from "@/lib/flows/types";
import { useT } from "@/lib/i18n/IdiomaProvider";
import {
  CaretDown,
  CaretLeft,
  CheckCircle,
  Clock,
  FlowArrow,
  MagnifyingGlass,
  Plus,
  Tag,
  X,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  CAMPOS_DO_SISTEMA_DO_PUBLICO,
  OPERADORES_DE_CAMPO,
  OPERADOR_DE_CAMPO_LABEL,
  SEGMENTO_VAZIO,
  STATUS_DE_DISPARO_LABEL,
  porQueNaoPodeAgendar,
  temCriterioDePublico,
  type CampoDoSistemaDoPublico,
  type CriterioDeCampo,
  type MensagemDeDisparo,
  type ModoDeDisparo,
  type OperadorDeCampo,
  type Segmento,
} from "@/lib/schemas/disparos";
import { ModeloDaMensagem } from "../../../flows/[id]/_components/NodeConfigPanel";

type GrupoDeCampos = "fields" | "fields_any" | "fields_none";
type SecaoAberta = "conteudo" | "publico" | "envio";
type ModoDeEnvio = "now" | "scheduled";

export function DisparoEditor({ inicial }: { inicial: DisparoDetalhe }) {
  const t = useT();
  const router = useRouter();
  const { activeOrg } = useAuth();
  const tagDeIdioma = useTagDeIdioma();
  const fuso = fusoDoAgendamento(activeOrg?.timezone);
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
  const paredeInicial = paredeDoAgendamento(disparo.scheduled_at, fuso);
  const [modoDeEnvio, setModoDeEnvio] = useState<ModoDeEnvio>(disparo.scheduled_at ? "scheduled" : "now");
  const [data, setData] = useState(paredeInicial.data);
  const [hora, setHora] = useState(paredeInicial.hora);
  const [aberta, setAberta] = useState<SecaoAberta | null>(emAndamento ? null : "conteudo");
  const [confirmando, setConfirmando] = useState(false);
  const [criandoModelo, setCriandoModelo] = useState(false);
  const [voltandoParaMensagem, setVoltandoParaMensagem] = useState(false);

  const modo: ModoDeDisparo = disparo.modo ?? (disparo.fluxo ? "fluxo" : "guiado");
  const editavel = disparo.status === "draft" || disparo.status === "paused";
  const rascunho = disparo.status === "draft";

  const temCriterio = temCriterioDePublico(segmento);
  const previa = usePreviaDePublico(segmento, temCriterio);
  const impedimento = useMemo(
    () => porQueNaoPodeAgendar({ segment: segmento, message: mensagem }, modo),
    [segmento, mensagem, modo],
  );
  const problemaDoHorario =
    modoDeEnvio === "scheduled"
      ? (data || hora ? problemaDoAgendamento(data, hora, fuso) : "Informe a data e a hora do envio.")
      : null;

  const scheduledAt =
    modoDeEnvio === "scheduled" ? (instanteDoAgendamento(data, hora, fuso)?.toISOString() ?? null) : null;

  // "Salvo" compara o que está na tela com o que o servidor devolveu — sem isso
  // a pessoa não sabe se sair da página perde alguma coisa.
  const salvo =
    nome.trim() === disparo.name &&
    JSON.stringify(segmento) === JSON.stringify({ ...SEGMENTO_VAZIO, ...(disparo.segment ?? {}) }) &&
    JSON.stringify(mensagem) ===
      JSON.stringify({
        ...(disparo.message ?? {}),
        window_mode: disparo.message?.window_mode ?? "outside_24h",
        body: disparo.message?.body ?? "",
        template_values: disparo.message?.template_values ?? {},
      }) &&
    (scheduledAt ?? null) === (disparo.scheduled_at ? new Date(disparo.scheduled_at).toISOString() : null);

  function mudarSegmento(patch: Partial<Segmento>) {
    setSegmento((s) => ({ ...s, ...patch }));
  }
  function mudarMensagem(patch: Record<string, unknown>) {
    setMensagem((m) => ({ ...m, ...patch }) as MensagemDeDisparo);
  }

  function entradaDoSalvamento() {
    return { name: nome.trim(), segment: segmento, message: mensagem, scheduled_at: scheduledAt };
  }

  async function salvarTudo() {
    return salvar.mutateAsync(entradaDoSalvamento());
  }

  async function irParaConstrutor() {
    // Salva ANTES de sair (nome, público, envio) e, se ainda é mensagem, troca o
    // modo — a rota cria o fluxo do disparo uma vez só e devolve o id dele.
    const r =
      modo === "guiado" && rascunho
        ? await salvar.mutateAsync({ ...entradaDoSalvamento(), modo: "fluxo" })
        : await salvarTudo();
    const fluxoId = r.fluxo?.id ?? disparo.fluxo?.id;
    if (fluxoId) router.push(`/app/flows/${fluxoId}`);
  }

  async function voltarParaMensagem() {
    await salvar.mutateAsync({ ...entradaDoSalvamento(), modo: "guiado" });
    setVoltandoParaMensagem(false);
  }

  async function confirmarEnvio() {
    await salvarTudo();
    await acao.mutateAsync("agendar");
    setConfirmando(false);
  }

  const total = disparo.total_recipients || 0;
  const concluidos = disparo.sent_count + disparo.failed_count + disparo.skipped_count;
  const progresso = total > 0 ? Math.round((concluidos / total) * 100) : 0;
  const bloqueioDoEnvio = impedimento ?? problemaDoHorario;
  const contagem = previa.data?.total ?? 0;
  const quandoPorExtenso =
    modoDeEnvio === "scheduled" && scheduledAt
      ? new Intl.DateTimeFormat(tagDeIdioma, { dateStyle: "long", timeStyle: "short", timeZone: fuso }).format(
          new Date(scheduledAt),
        )
      : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      {/* ── Cabeçalho: nome, estado e as ações ─────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button asChild variant="ghost" size="icon" aria-label={t("Voltar para os disparos")}>
            <Link href="/app/disparos">
              <CaretLeft size={18} aria-hidden />
            </Link>
          </Button>
          <div className="min-w-0">
            <p className="text-xs text-text-muted">
              <Link href="/app/disparos" className="hover:underline">
                {t("Disparos")}
              </Link>{" "}
              › {rascunho ? t("Rascunhos") : t(STATUS_DE_DISPARO_LABEL[disparo.status])}
            </p>
            {editavel ? (
              <Input
                value={nome}
                maxLength={120}
                onChange={(e) => setNome(e.target.value)}
                className="mt-0.5 h-9 max-w-md text-lg font-semibold"
                aria-label={t("Nome do disparo")}
              />
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight">{disparo.name}</h1>
            )}
            <p className="mt-1 flex flex-wrap gap-2 text-sm text-text-muted">
              <Badge variant="secondary">{t(STATUS_DE_DISPARO_LABEL[disparo.status])}</Badge>
              <Badge variant="outline" data-testid="modo-do-disparo">
                {modo === "fluxo" ? t("Construtor de fluxos") : t("Mensagem")}
              </Badge>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editavel && (
            <span className="text-xs text-text-muted" data-testid="estado-do-salvamento">
              {salvo ? `✓ ${t("Salvo")}` : t("Alterações não salvas")}
            </span>
          )}
          {editavel && (
            <Button variant="outline" onClick={() => void salvarTudo()} disabled={salvar.isPending}>
              {t("Salvar rascunho")}
            </Button>
          )}
          {editavel && (
            <Button
              onClick={() => setConfirmando(true)}
              disabled={!!bloqueioDoEnvio || !temCriterio || acao.isPending || salvar.isPending}
              data-testid="agendar-disparo"
            >
              {modoDeEnvio === "scheduled" ? (
                <>
                  <Clock size={15} aria-hidden className="mr-1" />
                  {disparo.status === "paused" ? t("Reagendar") : t("Agendar envio")}
                </>
              ) : disparo.status === "paused" ? (
                t("Reagendar")
              ) : (
                t("Enviar agora")
              )}
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
              {disparo.sent_count} {t("enviados")}
            </span>
            {(disparo.in_flow_count ?? 0) > 0 && (
              <span>
                {disparo.in_flow_count} {modo === "fluxo" ? t("em andamento no fluxo") : t("aguardando o canal")}
              </span>
            )}
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

      {/* ── 1. Conteúdo ────────────────────────────────────────────────────── */}
      <Secao
        id="conteudo"
        titulo={t("Conteúdo")}
        resumo={
          modo === "fluxo"
            ? t("Construtor de fluxos")
            : mensagem.window_mode === "outside_24h"
              ? mensagem.template_name
                ? `${t("Modelo")}: ${mensagem.template_name}`
                : t("Nenhum modelo escolhido")
              : t("Texto livre")
        }
        aberta={aberta === "conteudo"}
        onAlternar={() => setAberta((a) => (a === "conteudo" ? null : "conteudo"))}
        acao={
          modo === "guiado" && rascunho ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto gap-1 p-0 text-accent-600"
              onClick={() => void irParaConstrutor()}
              disabled={salvar.isPending}
              data-testid="ir-para-construtor"
            >
              <FlowArrow size={15} aria-hidden /> {t("Ir para o Construtor de Fluxos")}
            </Button>
          ) : null
        }
      >
        {modo === "guiado" ? (
          <fieldset disabled={!editavel} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <div className="rounded-md bg-accent-soft px-3 py-2 text-center text-sm font-semibold">
                {t("Enviar mensagem")}
              </div>
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
                <>
                  {/* O MESMO seletor, a mesma prévia e os mesmos espaços do nó de
                      mensagem dos Fluxos — o catálogo central. */}
                  <ModeloDaMensagem config={mensagem as unknown as MessageNodeConfig} patch={mudarMensagem} />
                  <CriarNovoModelo aberto={criandoModelo} onAbrir={setCriandoModelo} />
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="disparo-texto">{t("Mensagem")}</Label>
                  <Textarea
                    id="disparo-texto"
                    rows={5}
                    value={mensagem.body}
                    onChange={(e) => mudarMensagem({ body: e.target.value })}
                    placeholder={t("Digite uma mensagem")}
                  />
                  <div className="flex justify-end">
                    <InserirVariavel onInserir={(v) => mudarMensagem({ body: `${mensagem.body}${v}` })} />
                  </div>
                </div>
              )}
            </div>
            <PreviaNoCelular texto={mensagem.window_mode === "inside_24h" ? mensagem.body : null} />
          </fieldset>
        ) : (
          <div className="flex flex-col gap-3" data-testid="cartao-do-fluxo">
            <div className="flex flex-wrap items-center gap-2">
              <FlowArrow size={18} aria-hidden className="text-accent-600" />
              <p className="text-sm font-medium">{t("Este disparo usa o construtor de fluxos")}</p>
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
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void irParaConstrutor()}
                disabled={!disparo.fluxo || salvar.isPending}
                data-testid="configurar-fluxo"
              >
                {rascunho ? t("Abrir o Construtor de Fluxos") : t("Ver fluxo")}
              </Button>
              {rascunho && (
                <Button variant="ghost" onClick={() => setVoltandoParaMensagem(true)} disabled={salvar.isPending}>
                  {t("Voltar para mensagem única")}
                </Button>
              )}
            </div>
          </div>
        )}
      </Secao>

      {/* ── 2. Público-alvo ────────────────────────────────────────────────── */}
      <Secao
        id="publico"
        titulo={t("Público-alvo")}
        resumo={
          !temCriterio
            ? t("Nenhuma condição")
            : previa.isLoading
              ? t("Contando…")
              : `${contagem} ${t("contato(s)")}`
        }
        aberta={aberta === "publico"}
        onAlternar={() => setAberta((a) => (a === "publico" ? null : "publico"))}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <fieldset disabled={!editavel} className="flex min-w-0 flex-col gap-3">
            <p className="text-xs text-text-muted">
              {t(
                "Contatos bloqueados, anonimizados, mesclados ou sem telefone nunca entram — isso não é um filtro que dê para desligar.",
              )}
            </p>
            <GrupoDoPublico
              titulo={t("Incluir contatos que atendem a TODAS estas condições (E)")}
              tags={segmento.tags_all}
              onTags={(tags_all) => mudarSegmento({ tags_all })}
              campos={segmento.fields}
              onCampos={(fields) => mudarSegmento({ fields })}
              grupo="fields"
            />
            <GrupoDoPublico
              titulo={t("…e a PELO MENOS UMA destas condições (OU)")}
              tags={segmento.tags_any}
              onTags={(tags_any) => mudarSegmento({ tags_any })}
              campos={segmento.fields_any}
              onCampos={(fields_any) => mudarSegmento({ fields_any })}
              grupo="fields_any"
            />
            <GrupoDoPublico
              titulo={t("Excluir quem atende a QUALQUER destas condições (NÃO)")}
              tags={segmento.tags_none}
              onTags={(tags_none) => mudarSegmento({ tags_none })}
              campos={segmento.fields_none}
              onCampos={(fields_none) => mudarSegmento({ fields_none })}
              grupo="fields_none"
              exclusao
            />
          </fieldset>

          <aside className="flex h-fit flex-col gap-3 rounded-lg border border-border p-3" data-testid="previa-do-publico">
            <p className="text-sm font-semibold">
              {!temCriterio
                ? t("Escolha ao menos uma condição de inclusão")
                : previa.isError
                  ? t("Complete as condições (campo e valor) para contar")
                  : previa.isLoading
                    ? t("Contando…")
                    : `${contagem} ${t("contato(s) receberão este disparo")}`}
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
            <div className="border-t border-border pt-2 text-xs">
              {impedimento ? (
                <p className="text-warning-fg">{t(impedimento)}</p>
              ) : (
                <p className="flex items-center gap-1.5 text-success-fg">
                  <CheckCircle size={14} aria-hidden /> {t("Pronto para transmitir")}
                </p>
              )}
            </div>
          </aside>
        </div>
      </Secao>

      {/* ── 3. Envio ───────────────────────────────────────────────────────── */}
      <Secao
        id="envio"
        titulo={t("Envio")}
        resumo={modoDeEnvio === "now" ? t("Assim que confirmar") : (quandoPorExtenso ?? t("Escolha data e hora"))}
        aberta={aberta === "envio"}
        onAlternar={() => setAberta((a) => (a === "envio" ? null : "envio"))}
      >
        <fieldset disabled={!editavel} className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("Quando enviar")}>
            {(["now", "scheduled"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={modoDeEnvio === m}
                onClick={() => setModoDeEnvio(m)}
                data-testid={`envio-${m}`}
                className={cn(
                  "rounded-md border border-border p-3 text-left transition-colors disabled:cursor-not-allowed",
                  modoDeEnvio === m ? "border-accent-500 bg-accent-soft" : "hover:border-accent-400",
                )}
              >
                <p className="font-medium">{m === "now" ? t("Enviar agora") : t("Agendar")}</p>
                <p className="text-xs text-text-muted">
                  {m === "now"
                    ? t("O envio começa assim que você confirmar.")
                    : t("Escolha a data e a hora em que o envio começa.")}
                </p>
              </button>
            ))}
          </div>
          {modoDeEnvio === "scheduled" && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="disparo-data">{t("Data")}</Label>
                <Input id="disparo-data" type="date" className="w-44" value={data} onChange={(e) => setData(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="disparo-hora">{t("Hora")}</Label>
                <Input id="disparo-hora" type="time" className="w-32" value={hora} onChange={(e) => setHora(e.target.value)} />
              </div>
              <p className="pb-2 text-xs text-text-muted" data-testid="fuso-do-agendamento">
                {t("Fuso horário")}: {fuso}
              </p>
            </div>
          )}
          {problemaDoHorario && (data || hora) && (
            <p className="text-sm text-error-fg" data-testid="problema-do-horario">
              {t(problemaDoHorario)}
            </p>
          )}
          <p className="text-xs text-text-muted">
            {t(
              "O envio sai aos poucos, cerca de uma mensagem a cada cinco segundos, para proteger o número. Um público de 600 pessoas leva cerca de 50 minutos.",
            )}{" "}
            {t("Modelos novos precisam ser aprovados pela Meta antes do envio.")}
          </p>
        </fieldset>
      </Secao>

      {/* ── Confirmação ────────────────────────────────────────────────────── */}
      <AlertDialog open={confirmando} onOpenChange={setConfirmando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {modoDeEnvio === "scheduled" ? t("Agendar transmissão") : t("Enviar transmissão agora")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`${contagem} ${t("contato(s) receberão este disparo")}`}
              {quandoPorExtenso ? ` — ${quandoPorExtenso} (${fuso}).` : ` — ${t("o envio começa assim que você confirmar")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-envio"
              disabled={acao.isPending || salvar.isPending}
              onClick={(e) => {
                e.preventDefault();
                void confirmarEnvio();
              }}
            >
              {modoDeEnvio === "scheduled" ? t("Agendar transmissão") : t("Enviar agora")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={voltandoParaMensagem} onOpenChange={setVoltandoParaMensagem}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Voltar para mensagem única?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O fluxo deste disparo será apagado. Público e nome continuam como estão.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void voltarParaMensagem();
              }}
            >
              {t("Voltar para mensagem única")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Uma seção do acordeão: cabeçalho que abre/fecha, com resumo quando fechada. */
function Secao({
  id,
  titulo,
  resumo,
  aberta,
  onAlternar,
  acao,
  children,
}: {
  id: string;
  titulo: string;
  resumo: string;
  aberta: boolean;
  onAlternar: () => void;
  acao?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-background" data-testid={`secao-${id}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onAlternar}
          aria-expanded={aberta}
          aria-controls={`secao-${id}-conteudo`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-base font-semibold">{titulo}</span>
          <CaretDown
            size={15}
            aria-hidden
            className={cn("shrink-0 text-text-muted transition-transform", aberta && "rotate-180")}
          />
          {!aberta && <span className="truncate text-sm text-text-muted">· {resumo}</span>}
        </button>
        {acao}
      </div>
      {aberta && (
        <div id={`secao-${id}-conteudo`} className="border-t border-border px-4 py-4">
          {children}
        </div>
      )}
    </section>
  );
}

/** A mensagem de texto livre num balão, para ler como o contato vai ler. */
function PreviaNoCelular({ texto }: { texto: string | null }) {
  const t = useT();
  if (texto === null) return null;
  return (
    <div className="mx-auto w-full max-w-72 rounded-[2rem] border-8 border-neutral-800 bg-[#e5ddd5] p-3 shadow-sm">
      <div className="min-h-64 rounded-md">
        {texto.trim() ? (
          <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm">
            {texto}
          </p>
        ) : (
          <p className="pt-24 text-center text-xs text-neutral-600">{t("A prévia aparece aqui.")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * "Ou crie um novo modelo" — o MESMO formulário de Conexões › Modelos (G1),
 * aberto ali mesmo. Criar modelo é de administrador (a rota exige `admin`);
 * para os outros papéis a tela diz quem pode, em vez de oferecer um botão que
 * responderia 403.
 */
function CriarNovoModelo({ aberto, onAbrir }: { aberto: boolean; onAbrir: (v: boolean) => void }) {
  const t = useT();
  const { activeOrg } = useAuth();
  const admin = roleAtLeast(activeOrg?.role, "admin");
  const modelos = useTemplates({ enabled: admin });
  const conexoes = admin ? (modelos.data?.data.conexoes ?? []) : [];
  if (!admin) {
    return (
      <p className="text-xs text-text-muted">
        {t("Para criar um modelo novo, peça a um administrador em Conexões › API Oficial › Modelos.")}
      </p>
    );
  }
  return (
    <>
      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span className="h-px flex-1 bg-border" />
        {t("ou")}
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button type="button" variant="outline" onClick={() => onAbrir(true)} disabled={conexoes.length === 0}>
        <Plus size={14} aria-hidden className="mr-1" /> {t("Criar novo modelo")}
      </Button>
      {conexoes.length === 0 && !modelos.isLoading && (
        <p className="text-xs text-text-muted">{t("Conecte um número oficial para criar modelos.")}</p>
      )}
      <Dialog open={aberto} onOpenChange={onAbrir}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("Criar novo modelo")}</DialogTitle>
            <DialogDescription>
              {t(
                "A aprovação da Meta é necessária antes de enviar um novo modelo. Esse processo pode levar de alguns minutos até 24 horas.",
              )}
            </DialogDescription>
          </DialogHeader>
          <CriarModeloOficial conexoes={conexoes} aoCriar={() => onAbrir(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Um grupo do público: as condições (tags e campos) e o "+ Condição". O grupo
 * não sabe se é E, OU ou NÃO — quem dá o sentido é o lugar do segmento em que
 * ele grava.
 */
export function GrupoDoPublico({
  titulo,
  tags,
  onTags,
  campos,
  onCampos,
  grupo,
  exclusao = false,
}: {
  titulo: string;
  tags: string[];
  onTags: (tags: string[]) => void;
  campos: CriterioDeCampo[];
  onCampos: (campos: CriterioDeCampo[]) => void;
  grupo: GrupoDeCampos;
  exclusao?: boolean;
}) {
  const t = useT();
  const { data: registro = [] } = useCamposDoContato();

  function trocar(indice: number, patch: Partial<CriterioDeCampo>) {
    const atual = campos[indice];
    if (!atual) return;
    const proximo = [...campos];
    proximo[indice] = { ...atual, ...patch };
    onCampos(proximo);
  }

  const vazio = tags.length === 0 && campos.length === 0;

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3",
        exclusao ? "border-error-fg/30 bg-error-bg/30" : "border-border",
      )}
      data-testid={`grupo-${grupo}`}
    >
      <h3 className="text-sm font-medium">{titulo}</h3>
      {vazio && <p className="text-xs text-text-muted">{t("Nenhuma condição neste grupo.")}</p>}

      <ul className="flex flex-col gap-2">
        {tags.map((nome) => (
          <li
            key={`tag-${nome}`}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-sm"
            data-testid="condicao-tag"
          >
            <Tag size={14} aria-hidden className="text-text-muted" />
            <span className="text-text-muted">{t("Tag")}</span>
            <span className="text-text-muted">{t("é")}</span>
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium">{nome}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7"
              aria-label={`${t("Remover condição")} ${nome}`}
              onClick={() => onTags(tags.filter((v) => v !== nome))}
            >
              <X size={14} aria-hidden />
            </Button>
          </li>
        ))}

        {campos.map((criterio, i) => {
          const sistema = criterio.origem === "sistema";
          const rotulo = sistema
            ? t(CAMPOS_DO_SISTEMA_DO_PUBLICO[criterio.key as CampoDoSistemaDoPublico] ?? criterio.key)
            : (registro.find((c) => c.key === criterio.key)?.label ?? criterio.key);
          return (
            <li
              key={`campo-${i}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-elevated px-2 py-1.5"
              data-testid="condicao-campo"
            >
              <span className="text-sm font-medium">{rotulo}</span>
              <Badge variant="outline" className="text-[10px]">
                {sistema ? t("Sistema") : t("Personalizado")}
              </Badge>
              <Select value={criterio.op} onValueChange={(op) => trocar(i, { op: op as OperadorDeCampo })}>
                <SelectTrigger className="h-8 w-40" aria-label={t("Operador")}>
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
              {criterio.op !== "set" && criterio.op !== "unset" &&
                (sistema ? (
                  <Input
                    className="h-8 w-44"
                    value={criterio.value}
                    aria-label={t("Valor")}
                    placeholder={t("valor")}
                    onChange={(e) => trocar(i, { value: e.target.value })}
                  />
                ) : (
                  <ValorDoCampo chave={criterio.key} valor={criterio.value} onChange={(value) => trocar(i, { value })} />
                ))}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto h-7 w-7"
                aria-label={t("Remover critério")}
                onClick={() => onCampos(campos.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      <MenuDeCondicao
        grupo={grupo}
        tagsJaEscolhidas={tags}
        onTag={(nome) => {
          if (!tags.some((v) => v.toLowerCase() === nome.toLowerCase())) onTags([...tags, nome]);
        }}
        onCampo={(key, origem) =>
          onCampos([...campos, { key, op: "eq", value: "", ...(origem === "sistema" ? { origem } : {}) }])
        }
      />
    </section>
  );
}

type Categoria = "gerais" | "sistema" | "personalizados";

/**
 * "+ Condição": busca no topo, categorias à esquerda, opções à direita.
 *
 * POPOVER em portal (camada própria, com colisão de borda do Radix) — nunca
 * mais um `Select` vazio desenhando uma barra fora do lugar. A lista tem altura
 * máxima e rola dentro dela; o vazio de cada categoria é uma frase com o
 * caminho, não um vão. Buscando, a busca atravessa as três categorias.
 */
function MenuDeCondicao({
  grupo,
  tagsJaEscolhidas,
  onTag,
  onCampo,
}: {
  grupo: GrupoDeCampos;
  tagsJaEscolhidas: string[];
  onTag: (nome: string) => void;
  onCampo: (key: string, origem: "sistema" | "personalizado") => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState<Categoria>("gerais");
  const [escolhendoTag, setEscolhendoTag] = useState(false);
  const { opcoes: tags, carregando } = useOpcoesDeEtiqueta();
  const { data: campos = [] } = useCamposDoContato();

  const termo = busca.trim().toLowerCase();
  const casa = (s: string) => !termo || s.toLowerCase().includes(termo);
  const escolhidas = new Set(tagsJaEscolhidas.map((v) => v.toLowerCase()));
  const tagsDisponiveis = tags.filter((n) => !escolhidas.has(n.toLowerCase()) && casa(n));
  const sistema = (Object.keys(CAMPOS_DO_SISTEMA_DO_PUBLICO) as CampoDoSistemaDoPublico[]).filter((k) =>
    casa(t(CAMPOS_DO_SISTEMA_DO_PUBLICO[k])),
  );
  const personalizados = campos.filter((c) => casa(c.label) || casa(c.key));

  function fechar() {
    setAberto(false);
    setBusca("");
    setEscolhendoTag(false);
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-hidden";

  const listaDeTags = (
    <>
      {tagsDisponiveis.map((nome) => (
        <li key={`t-${nome}`}>
          <button
            type="button"
            className={itemClass}
            onClick={() => {
              onTag(nome);
              fechar();
            }}
          >
            <Tag size={14} aria-hidden className="text-text-muted" /> {nome}
          </button>
        </li>
      ))}
      {!carregando && tagsDisponiveis.length === 0 && (
        <li className="px-2 py-1.5 text-xs text-text-muted" data-testid="condicao-sem-tags">
          {tags.length === 0 ? t("Nenhuma tag cadastrada ou aplicada ainda.") : t("Nenhuma tag encontrada.")}
        </li>
      )}
    </>
  );
  const listaDoSistema = sistema.map((k) => (
    <li key={`s-${k}`}>
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          onCampo(k, "sistema");
          fechar();
        }}
      >
        {t(CAMPOS_DO_SISTEMA_DO_PUBLICO[k])}
      </button>
    </li>
  ));
  const listaPersonalizada = (
    <>
      {personalizados.map((c) => (
        <li key={`p-${c.id}`}>
          <button
            type="button"
            className={itemClass}
            onClick={() => {
              onCampo(c.key, "personalizado");
              fechar();
            }}
          >
            {c.label}
          </button>
        </li>
      ))}
      {personalizados.length === 0 && (
        <li className="px-2 py-1.5 text-xs text-text-muted">
          {campos.length === 0
            ? t("Nenhum campo cadastrado ainda. Crie em Configurações › Campos do Usuário.")
            : t("Nenhum campo encontrado.")}
        </li>
      )}
    </>
  );

  return (
    <Popover open={aberto} onOpenChange={(v) => (v ? setAberto(true) : fechar())}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-dashed text-accent-600"
          data-testid={`adicionar-criterio-${grupo}`}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Condição")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[min(34rem,calc(100vw-2rem))] p-0"
        data-testid={`menu-de-condicao-${grupo}`}
      >
        <div className="border-b border-border p-2">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
              aria-hidden
            />
            <Input
              autoFocus
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar tag ou campo…")}
              aria-label={t("Buscar condição")}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        {termo ? (
          <ul className="max-h-72 overflow-y-auto p-1">
            <li className="px-2 pt-1 text-[11px] font-semibold uppercase text-text-muted">{t("Tags")}</li>
            {listaDeTags}
            <li className="px-2 pt-2 text-[11px] font-semibold uppercase text-text-muted">{t("Campos do sistema")}</li>
            {listaDoSistema}
            <li className="px-2 pt-2 text-[11px] font-semibold uppercase text-text-muted">
              {t("Campos personalizados do usuário")}
            </li>
            {listaPersonalizada}
          </ul>
        ) : (
          <div className="grid grid-cols-[11rem_minmax(0,1fr)] max-sm:grid-cols-1">
            <ul className="border-r border-border p-1 max-sm:border-b max-sm:border-r-0" role="tablist">
              {(
                [
                  ["gerais", t("Filtros gerais")],
                  ["sistema", t("Campos do sistema")],
                  ["personalizados", t("Campos personalizados do usuário")],
                ] as const
              ).map(([valor, rotulo]) => (
                <li key={valor}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={categoria === valor}
                    onClick={() => {
                      setCategoria(valor);
                      setEscolhendoTag(false);
                    }}
                    className={cn(itemClass, categoria === valor && "bg-surface-elevated font-medium")}
                  >
                    {rotulo}
                  </button>
                </li>
              ))}
            </ul>
            <ul className="max-h-72 overflow-y-auto p-1">
              {categoria === "gerais" &&
                (escolhendoTag ? (
                  <>
                    <li>
                      <button type="button" className={cn(itemClass, "text-text-muted")} onClick={() => setEscolhendoTag(false)}>
                        <CaretLeft size={13} aria-hidden /> {t("Tag")}
                      </button>
                    </li>
                    {listaDeTags}
                  </>
                ) : (
                  <li>
                    <button type="button" className={itemClass} onClick={() => setEscolhendoTag(true)} data-testid="condicao-tipo-tag">
                      <Tag size={14} aria-hidden className="text-text-muted" /> {t("Tag")}
                    </button>
                  </li>
                ))}
              {categoria === "sistema" && listaDoSistema}
              {categoria === "personalizados" && listaPersonalizada}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
