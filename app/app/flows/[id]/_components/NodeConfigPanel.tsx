"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { CaretDown, CaretUp, Trash, Plus, X } from "@/lib/ui/icons";
import { InserirVariavel } from "@/components/catalogo/InserirVariavel";
import { SeletorDeCampo, SeletorDeTags } from "@/components/catalogo/SeletorDeCampo";
import type { RuleCondition } from "@/lib/automation/conditions";
import { ACOES_DO_FLOW, acaoPorTipo, acoesDoNo, type CampoDeAcao } from "@/lib/flows/acoes";
import { FLOW_TRIGGERS, type FlowTriggerId } from "@/lib/flows/triggers";
import { proximoSlot, renomearSlot } from "@/lib/flows/slots";
import type {
  AcaoConfigurada,
  ActionNodeConfig,
  ConditionNodeConfig,
  DelayNodeConfig,
  FlowNodeType,
  MessageNodeConfig,
  TriggerNodeConfig,
  WebhookNodeConfig,
} from "@/lib/flows/types";
import type { RFNode } from "@/lib/flows/ui-mappers";
import {
  acharModeloNoCatalogo,
  configDoModeloEscolhido,
  useCatalogoDeModelos,
} from "@/hooks/channels/useCatalogoDeModelos";
import { NODE_VISUALS } from "./nodeVisuals";
import { PreviaDoModelo } from "./PreviaDoModelo";
import { SeletorDeModelo } from "./SeletorDeModelo";
import { TriggerPicker } from "./TriggerPicker";

interface Props {
  node: RFNode;
  onChange: (patch: Partial<RFNode["data"]>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function Campo({ label, ajuda, children }: { label: string; ajuda?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-text-muted">{label}</Label>
      {children}
      {ajuda && <p className="text-xs text-text-muted">{ajuda}</p>}
    </div>
  );
}

export function NodeConfigPanel({ node, onChange, onDelete, onDuplicate }: Props) {
  const t = useT();
  const type = node.type as FlowNodeType;
  const visual = NODE_VISUALS[type];
  const config = node.data.config;

  function patchConfig(patch: Record<string, unknown>) {
    onChange({ config: { ...config, ...patch } });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(visual.paletteLabel)}</h3>
        {type !== "TRIGGER" && (
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onDuplicate}>
              {t("Duplicar")}
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={onDelete} aria-label={t("Excluir passo")}>
              <Trash size={16} aria-hidden />
            </Button>
          </div>
        )}
      </div>

      <Campo label={t("Nome do passo (só pra você — não sai na mensagem)")}>
        <Input value={node.data.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Campo>

      {type === "TRIGGER" && <CamposDoGatilho config={config as TriggerNodeConfig} patch={patchConfig} />}
      {type === "MESSAGE" && <CamposDeMensagem config={config as MessageNodeConfig} patch={patchConfig} />}
      {type === "CONDITION" && <CamposDeCondicao config={config as ConditionNodeConfig} patch={patchConfig} />}
      {type === "ACTION" && <CamposDeAcao config={config as ActionNodeConfig} patch={patchConfig} />}
      {type === "DELAY" && <CamposDeEspera config={config as DelayNodeConfig} patch={patchConfig} />}
      {type === "WEBHOOK" && <CamposDeWebhook config={config as WebhookNodeConfig} patch={patchConfig} />}
      {type === "END" && (
        <p className="text-xs text-text-muted">{t("Encerra a execução do flow para este contato.")}</p>
      )}
    </div>
  );
}

function CamposDoGatilho({
  config,
  patch,
}: {
  config: TriggerNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  // Rascunho recém-criado (sem gatilho): o seletor abre sozinho — o fluxo nasceu
  // no construtor justamente para o gatilho ser a primeira escolha, aqui.
  const [aberto, setAberto] = useState(!config.trigger_type);
  // O gatilho do DISPARO (0394) não se escolhe: o fluxo é do disparo e começa
  // quando o disparo alcança cada contato do público.
  if (config.trigger_type === "broadcast") {
    const def = FLOW_TRIGGERS.broadcast;
    return (
      <Campo label={t("Quando isto acontecer")}>
        <p className="rounded-md border border-border px-3 py-2 text-sm" data-testid="gatilho-do-disparo">
          {t(def.label)}
        </p>
        <p className="text-xs text-text-muted">{t(def.description)}</p>
      </Campo>
    );
  }
  const triggerId = (config.trigger_type ?? null) as FlowTriggerId | null;
  const def = triggerId ? FLOW_TRIGGERS[triggerId] : undefined;
  const cfg = config.config ?? {};

  return (
    <>
      <Campo label={t("Quando isto acontecer")}>
        {def ? (
          <Button type="button" variant="outline" className="justify-start" onClick={() => setAberto(true)}>
            {t(def.label)}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="border-dashed text-accent"
            onClick={() => setAberto(true)}
            data-testid="novo-gatilho"
          >
            <Plus size={14} aria-hidden className="mr-1" /> {t("Novo gatilho")}
          </Button>
        )}
        {def ? (
          <p className="text-xs text-text-muted">{t(def.description)}</p>
        ) : (
          <p className="text-xs text-text-muted">
            {t("O gatilho decide o que coloca um contato neste fluxo. Você pode salvar sem ele; para ativar, ele é obrigatório.")}
          </p>
        )}
      </Campo>

      {def?.field && (
        <Campo label={t(def.field.label)}>
          <Input
            value={typeof cfg[def.field.key] === "string" ? String(cfg[def.field.key]) : ""}
            placeholder={def.field.placeholder ? t(def.field.placeholder) : undefined}
            onChange={(e) => patch({ config: { ...cfg, [def.field!.key]: e.target.value } })}
          />
        </Campo>
      )}

      <TriggerPicker
        open={aberto}
        onOpenChange={setAberto}
        atual={triggerId ?? undefined}
        onEscolher={(id) => patch({ trigger_type: id, config: {} })}
      />
    </>
  );
}

/**
 * O passo de WhatsApp.
 *
 * ── Por que os dois modos mostram formulários diferentes ────────────────────
 *
 * Não é preferência de layout: é a regra da plataforma. Dentro da janela de 24
 * horas sai texto livre; fora dela, só template aprovado, e o texto do template
 * não está aqui — está na Meta. O que se preenche fora da janela são os VALORES
 * dos espaços do template, e é por isso que o formulário troca inteiro em vez
 * de esconder um campo.
 *
 * ── Os valores do template também aceitam variável ──────────────────────────
 *
 * É o que fecha a cadeia que o produto pede: o nó de ações grava
 * `produto_interesse`, e o espaço {{1}} do template aprovado recebe
 * `{{contact.custom_fields.produto_interesse}}`. Sem isso, template fora da
 * janela só mandaria texto fixo — e um disparo de template sem personalização
 * é exatamente o que a Meta reprova.
 */
function CamposDeMensagem({
  config,
  patch,
}: {
  config: MessageNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  const botoes = config.buttons ?? [];
  const foraDaJanela = config.window_mode === "outside_24h";

  return (
    <>
      <Campo
        label={t("Quando enviar")}
        ajuda={
          foraDaJanela
            ? t("Fora da janela, a plataforma só aceita template aprovado — e só pelo canal oficial.")
            : t("Dentro da janela de 24h: texto livre, para quem falou com você recentemente.")
        }
      >
        <Select
          value={config.window_mode ?? "inside_24h"}
          onValueChange={(v) => patch({ window_mode: v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inside_24h">{t("Dentro da janela de 24 horas")}</SelectItem>
            <SelectItem value="outside_24h">{t("Fora da janela de 24 horas (template)")}</SelectItem>
          </SelectContent>
        </Select>
      </Campo>

      {foraDaJanela ? (
        <ModeloDaMensagem config={config} patch={patch} />
      ) : (
        <Campo
          label={t("Texto da mensagem")}
          ajuda={t(
            "O botão ao lado insere a variável certa — inclusive os campos do usuário que você cadastrou.",
          )}
        >
          <div className="flex flex-col gap-2">
            <Textarea
              rows={5}
              value={config.body ?? ""}
              onChange={(e) => patch({ body: e.target.value })}
            />
            <div className="flex justify-end">
              {/* Acrescenta no FIM do texto, e não na posição do cursor: o
                  `Textarea` aqui não é controlado por ref, e ler a seleção
                  pediria um componente novo. Acrescentar no fim é previsível e
                  o operador reposiciona com um recortar-e-colar. */}
              <InserirVariavel onInserir={(v) => patch({ body: `${config.body ?? ""}${v}` })} />
            </div>
          </div>
        </Campo>
      )}

      {!foraDaJanela && (
      <Campo
        label={t("Botões")}
        ajuda={t("Cada botão vira uma saída do passo: ligue cada um ao caminho que ele deve seguir.")}
      >
        <div className="flex flex-col gap-2">
          {botoes.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={b.label}
                onChange={(e) => {
                  const next = [...botoes];
                  next[i] = { label: e.target.value };
                  patch({ buttons: next });
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => patch({ buttons: botoes.filter((_, j) => j !== i) })}
                aria-label={t("Remover botão")}
              >
                <X size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => patch({ buttons: [...botoes, { label: `${t("Opção")} ${botoes.length + 1}` }] })}
          >
            <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar botão")}
          </Button>
        </div>
      </Campo>
      )}
    </>
  );
}

/**
 * O modelo aprovado do passo de mensagem fora da janela.
 *
 * O caminho principal é ESCOLHER: o seletor lista o catálogo e o nó guarda o id
 * do modelo + o retrato (nome, idioma, contrato). Os espaços a preencher saem do
 * CONTRATO do modelo — o operador não digita `1`, `header:1` nem `button0:1`.
 *
 * Nó antigo (só nome e idioma digitados) continua funcionando: se o catálogo o
 * localiza, a tela mostra o modelo e oferece VINCULAR; se não localiza, diz isso
 * com todas as letras e mantém o editor antigo dos espaços, para não tirar do
 * operador o que ele já tinha configurado.
 */
export function ModeloDaMensagem({
  config,
  patch,
}: {
  config: MessageNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [seletorAberto, setSeletorAberto] = useState(false);
  const catalogo = useCatalogoDeModelos({ todos: true });
  const modelo = acharModeloNoCatalogo(catalogo.data, config);
  const valores = config.template_values ?? {};
  const temRetrato = !!config.template_name?.trim() && !!config.template_language?.trim();
  const vinculado = !!config.template_id;
  const mudou =
    vinculado && !!modelo && !!config.template_contract_hash && config.template_contract_hash !== modelo.contractHash;

  const seletor = (
    <SeletorDeModelo
      open={seletorAberto}
      onOpenChange={setSeletorAberto}
      conexaoAtual={config.channel_session_id}
      modeloAtual={config.template_id}
      onEscolher={(m, conexaoId) => patch(configDoModeloEscolhido(m, conexaoId, valores))}
    />
  );

  if (!temRetrato && !vinculado) {
    return (
      <>
        <Campo label={t("Modelo aprovado")}>
          <Button
            type="button"
            variant="outline"
            className="h-20 border-dashed"
            onClick={() => setSeletorAberto(true)}
            data-testid="escolher-modelo"
          >
            {t("Escolher modelo de mensagem")}
          </Button>
        </Campo>
        {seletor}
      </>
    );
  }

  return (
    <>
      <Campo label={t("Modelo aprovado")}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" data-testid="modelo-escolhido">
              {modelo?.name ?? config.template_name}
            </p>
            <p className="text-xs text-text-muted">
              {[modelo?.language ?? config.template_language, modelo?.category, modelo?.status]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setSeletorAberto(true)}>
              {t("Trocar")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Remover modelo")}
              onClick={() =>
                patch({
                  template_id: undefined,
                  template_name: undefined,
                  template_language: undefined,
                  template_contract_hash: undefined,
                  template_values: {},
                  buttons: [],
                })
              }
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
        </div>

        {catalogo.isLoading && <p className="text-xs text-text-muted">{t("Carregando o modelo…")}</p>}

        {catalogo.data && !modelo && (
          <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning-fg" role="alert">
            {t("Modelo não localizado no catálogo")} ({config.template_name}, {config.template_language}).{" "}
            {vinculado
              ? t("Ele pode ter sido apagado da plataforma. Escolha o modelo de novo antes de ativar.")
              : t("Este passo foi configurado pelo nome. Sincronize os modelos em Conexões ou escolha o modelo na lista.")}
          </p>
        )}
        {modelo && !modelo.utilizavel && (
          <p className="rounded-md border border-error/40 bg-error-bg px-3 py-2 text-xs text-error-fg" role="alert">
            {t("Este modelo não está aprovado")} ({modelo.status}).{" "}
            {t("A plataforma só entrega modelo aprovado. Escolha outro.")}
          </p>
        )}
        {mudou && (
          <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning-fg" role="alert">
            {t("O modelo mudou na plataforma depois de escolhido. Confira os espaços e escolha-o de novo para confirmar.")}
          </p>
        )}
        {modelo && !vinculado && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <span className="text-text-muted">{t("Configurado pelo nome, antes do seletor.")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => patch(configDoModeloEscolhido(modelo, config.channel_session_id ?? null, valores))}
            >
              {t("Vincular a este modelo")}
            </Button>
          </div>
        )}
      </Campo>

      {modelo && <PreviaDoModelo modelo={modelo} />}

      {modelo ? (
        modelo.espacos.length > 0 && (
          <Campo
            label={t("Valores dos espaços do modelo")}
            ajuda={t("Use variáveis para personalizar com os dados do contato e o que as ações gravaram antes deste passo.")}
          >
            <div className="flex flex-col gap-3">
              {modelo.espacos.map((e) => {
                const valor = valores[e.valueKey] ?? "";
                return (
                  <div key={e.valueKey} className="flex flex-col gap-1">
                    <span className="text-xs text-text-muted">
                      <span className="font-mono">{`{{${e.key}}}`}</span> · {e.onde}
                      {(e.contextBefore || e.contextAfter) && (
                        <span className="ml-1 italic">
                          — “{e.contextBefore.slice(-30)}___{e.contextAfter.slice(0, 30)}”
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Input
                        value={valor}
                        aria-label={`${t("Valor de")} {{${e.key}}} (${e.onde})`}
                        onChange={(ev) => patch({ template_values: { ...valores, [e.valueKey]: ev.target.value } })}
                      />
                      <InserirVariavel
                        onInserir={(v) => patch({ template_values: { ...valores, [e.valueKey]: `${valor}${v}` } })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Campo>
        )
      ) : (
        <EspacosManuais valores={valores} patch={patch} />
      )}

      {modelo && modelo.conteudo.botoes.some((b) => b.tipo === "QUICK_REPLY") && (
        <p className="text-xs text-text-muted">
          {t("Cada resposta rápida do modelo vira uma saída deste passo: ligue cada uma ao caminho que ela deve seguir.")}
        </p>
      )}

      {seletor}
    </>
  );
}

/**
 * O editor ANTIGO dos espaços — chave e valor digitados. Só aparece para nó
 * cujo modelo o catálogo não localiza: é o que ele já tinha, e tirar faria o
 * operador perder a configuração ao abrir o passo.
 */
function EspacosManuais({
  valores,
  patch,
}: {
  valores: Record<string, string>;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  return (
    <Campo
      label={t("Valores dos espaços do template")}
      ajuda={t("Cada espaço do template aprovado ({{1}}, {{2}}…) recebe um valor.")}
    >
      <div className="flex flex-col gap-2">
        {Object.entries(valores).map(([slot, valor]) => (
          <div key={slot} className="flex items-center gap-2">
            <Input
              className="w-24 shrink-0 font-mono text-xs"
              value={slot}
              aria-label={t("Espaço do template")}
              onChange={(e) => patch({ template_values: renomearSlot(valores, slot, e.target.value) })}
            />
            <Input value={valor} onChange={(e) => patch({ template_values: { ...valores, [slot]: e.target.value } })} />
            <InserirVariavel onInserir={(v) => patch({ template_values: { ...valores, [slot]: `${valor}${v}` } })} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                const proximo = { ...valores };
                delete proximo[slot];
                patch({ template_values: proximo });
              }}
              aria-label={`${t("Remover espaço")} ${slot}`}
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => patch({ template_values: { ...valores, [proximoSlot(valores)]: "" } })}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar espaço")}
        </Button>
      </div>
    </Campo>
  );
}

const OP_LABELS: Record<RuleCondition["op"], string> = {
  eq: "é igual a",
  neq: "é diferente de",
  contains: "contém",
};

function CamposDeCondicao({
  config,
  patch,
}: {
  config: ConditionNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  const checks = config.checks ?? [];
  return (
    <Campo label={t("Condições (todas precisam ser verdadeiras)")}>
      <div className="flex flex-col gap-2">
        {checks.map((check, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
            <Input
              placeholder={t("campo (ex.: contact.tags, contact.custom_fields.plano)")}
              value={check.field}
              onChange={(e) => {
                const next = [...checks];
                next[i] = { ...check, field: e.target.value };
                patch({ checks: next });
              }}
            />
            <div className="flex items-center gap-2">
              <Select
                value={check.op}
                onValueChange={(op) => {
                  const next = [...checks];
                  next[i] = { ...check, op: op as RuleCondition["op"] };
                  patch({ checks: next });
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OP_LABELS) as RuleCondition["op"][]).map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(OP_LABELS[op])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder={t("valor")}
                value={check.value}
                onChange={(e) => {
                  const next = [...checks];
                  next[i] = { ...check, value: e.target.value };
                  patch({ checks: next });
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => patch({ checks: checks.filter((_, j) => j !== i) })}
                aria-label={t("Remover condição")}
              >
                <X size={14} aria-hidden />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => patch({ checks: [...checks, { field: "", op: "eq", value: "" }] })}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar condição")}
        </Button>
      </div>
    </Campo>
  );
}

/** O formulário da ação sai do catálogo — ação nova não pede componente novo. */
function CampoDaAcao({
  campo,
  valor,
  onChange,
}: {
  campo: CampoDeAcao;
  valor: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  // `label`, `ajuda` e `placeholder` vêm do CATÁLOGO (lib/flows/acoes.ts), que é
  // dado e não componente — por isso a tradução acontece aqui, no ponto de
  // renderização, e não numa constante de módulo que congelaria o idioma.
  const ajuda = campo.ajuda ? t(campo.ajuda) : undefined;
  const placeholder = campo.placeholder ? t(campo.placeholder) : undefined;
  if (campo.kind === "tags") {
    return (
      <Campo label={t(campo.label)} ajuda={ajuda}>
        <SeletorDeTags
          valor={Array.isArray(valor) ? (valor as string[]) : []}
          onChange={onChange}
          placeholder={placeholder}
        />
      </Campo>
    );
  }
  if (campo.kind === "campo") {
    return (
      <Campo label={t(campo.label)} ajuda={ajuda}>
        <SeletorDeCampo valor={typeof valor === "string" ? valor : ""} onChange={onChange} />
      </Campo>
    );
  }
  return (
    <Campo label={t(campo.label)} ajuda={ajuda}>
      <Input
        type={campo.kind === "segredo" ? "password" : "text"}
        value={typeof valor === "string" ? valor : ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Campo>
  );
}

/**
 * O nó de ações guarda uma LISTA, executada de cima para baixo.
 *
 * A ordem é visível e reordenável porque ela IMPORTA: a mensagem logo depois lê
 * a variável do campo, e o valor só está lá se a ação que o gravou estiver
 * acima. Esconder a ordem faria o operador descobrir isso pelo WhatsApp do
 * cliente, com a variável vazia.
 *
 * `patch({ actions })` sempre grava a LISTA. `acoesDoNo()` converte o formato
 * antigo (uma ação só, em `action_type`) na primeira abertura, então um flow
 * salvo antes desta fatia sobe para o formato novo assim que alguém o edita —
 * sem migration de jsonb.
 */
function CamposDeAcao({ config, patch }: { config: ActionNodeConfig; patch: (p: Record<string, unknown>) => void }) {
  const t = useT();
  const acoes = acoesDoNo(config);

  function escrever(lista: AcaoConfigurada[]) {
    // `action_type`/`config` viram undefined para o jsonb não carregar as duas
    // formas ao mesmo tempo — duas verdades sobre o que este nó faz.
    patch({ actions: lista, action_type: undefined, config: undefined });
  }

  function trocarTipo(indice: number, type: string) {
    const lista = [...acoes];
    lista[indice] = { action_type: type, config: {} };
    escrever(lista);
  }

  function trocarConfig(indice: number, chave: string, valor: unknown) {
    const atual = acoes[indice];
    if (!atual) return;
    const lista = [...acoes];
    lista[indice] = { ...atual, config: { ...(atual.config ?? {}), [chave]: valor } };
    escrever(lista);
  }

  function mover(indice: number, direcao: -1 | 1) {
    const destino = indice + direcao;
    if (destino < 0 || destino >= acoes.length) return;
    const aqui = acoes[indice];
    const ali = acoes[destino];
    if (!aqui || !ali) return;
    const lista = [...acoes];
    lista[indice] = ali;
    lista[destino] = aqui;
    escrever(lista);
  }

  return (
    <Campo
      label={t("Realize as seguintes ações")}
      ajuda={
        acoes.length > 1
          ? t(
              "Executadas de cima para baixo. Se uma falhar, as seguintes não rodam — e a mensagem depois deste passo também não sai.",
            )
          : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {acoes.map((acao, i) => {
          const def = acaoPorTipo(acao.action_type);
          const inner = acao.config ?? {};
          return (
            <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-2">
              <div className="flex items-center gap-1">
                <span className="w-5 shrink-0 text-center text-xs text-text-muted">{i + 1}</span>
                <Select value={acao.action_type} onValueChange={(v) => trocarTipo(i, v)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACOES_DO_FLOW.map((a) => (
                      <SelectItem key={a.type} value={a.type}>
                        {t(a.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={i === 0}
                  onClick={() => mover(i, -1)}
                  aria-label={t("Subir ação")}
                >
                  <CaretUp size={14} aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={i === acoes.length - 1}
                  onClick={() => mover(i, 1)}
                  aria-label={t("Descer ação")}
                >
                  <CaretDown size={14} aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => escrever(acoes.filter((_, j) => j !== i))}
                  aria-label={t("Remover ação")}
                >
                  <X size={14} aria-hidden />
                </Button>
              </div>
              {def?.descricao && <p className="pl-6 text-xs text-text-muted">{t(def.descricao)}</p>}
              <div className="flex flex-col gap-2 pl-6">
                {(def?.campos ?? []).map((campo) => (
                  <CampoDaAcao
                    key={campo.key}
                    campo={campo}
                    valor={inner[campo.key]}
                    onChange={(v) => trocarConfig(i, campo.key, v)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => escrever([...acoes, { action_type: "add_tag", config: {} }])}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar ação")}
        </Button>
      </div>
    </Campo>
  );
}

const UNIDADES = [
  { id: "min", label: "minutos", ms: 60_000 },
  { id: "h", label: "horas", ms: 3_600_000 },
  { id: "d", label: "dias", ms: 86_400_000 },
] as const;

function CamposDeEspera({ config, patch }: { config: DelayNodeConfig; patch: (p: Record<string, unknown>) => void }) {
  const t = useT();
  const ms = Number(config.duration_ms) || 300_000;
  // A unidade mostrada é a MAIOR que divide exato — 2h não vira "120 minutos".
  const unidade = [...UNIDADES].reverse().find((u) => ms % u.ms === 0) ?? UNIDADES[0];
  const quantidade = Math.max(1, Math.round(ms / unidade.ms));

  return (
    <Campo label={t("Esperar quanto tempo")}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={quantidade}
          onChange={(e) => patch({ duration_ms: Math.max(1, Number(e.target.value) || 1) * unidade.ms })}
        />
        <Select
          value={unidade.id}
          onValueChange={(id) => {
            const nova = UNIDADES.find((u) => u.id === id) ?? UNIDADES[0];
            patch({ duration_ms: quantidade * nova.ms });
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNIDADES.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {t(u.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Campo>
  );
}

function CamposDeWebhook({
  config,
  patch,
}: {
  config: WebhookNodeConfig;
  patch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  return (
    <>
      <Campo label={t("URL (ex.: seu webhook do N8N)")}>
        <Input value={config.url ?? ""} onChange={(e) => patch({ url: e.target.value })} placeholder="https://..." />
      </Campo>
      <Campo
        label={t("Segredo HMAC (opcional)")}
        ajuda={t("Assina o corpo enviado, para o outro lado conferir que a chamada veio daqui.")}
      >
        <Input value={config.secret ?? ""} onChange={(e) => patch({ secret: e.target.value })} type="password" />
      </Campo>
    </>
  );
}
