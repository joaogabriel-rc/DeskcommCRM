"use client";

import type { NodeProps } from "@xyflow/react";

import { acharModeloNoCatalogo, useCatalogoDeModelos } from "@/hooks/channels/useCatalogoDeModelos";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { blocosDaMensagem, saidasDeBotao, usaBlocos } from "@/lib/flows/blocos";
import type { FlowNodeType, MessageNodeConfig, TriggerNodeConfig } from "@/lib/flows/types";
import { Clock, ImageSquare, LinkSimple } from "@/lib/ui/icons";
import type { RFNode } from "@/lib/flows/ui-mappers";
import { describeNodeConfig, NODE_VISUALS } from "./nodeVisuals";
import { NodeCard, type NodeCardHandle } from "./NodeCard";
import { PreviaDoModelo } from "./PreviaDoModelo";

/**
 * As saídas do nó.
 *
 * MESSAGE com botões vira um card com uma linha por botão, cada uma com a sua
 * bolinha — é o que torna "qual caminho sai de qual botão" visível sem abrir
 * nada. Com modelo aprovado escolhido, os botões SÃO as respostas rápidas do
 * modelo (gravadas em `buttons` na escolha), então a mesma regra vale. Sem
 * botões, é a saída única de sempre. CONDITION tem as duas saídas fixas.
 */
function saidasDoNo(type: FlowNodeType, config: Record<string, unknown>): NodeCardHandle[] | undefined {
  if (type === "MESSAGE") {
    // Só os botões de FLUXO são saídas; o de URL abre o site (fica no corpo do card).
    const saidas = saidasDeBotao(config as MessageNodeConfig);
    if (!saidas.length) return undefined;
    return saidas.map((s, i) => ({ id: s.handle, label: s.rotulo || `Opção ${i + 1}` }));
  }
  if (type === "CONDITION") {
    return [
      { id: "true", label: "Sim" },
      { id: "false", label: "Não" },
    ];
  }
  return undefined;
}

/**
 * O modelo escolhido, dentro do card — o conteúdo vem do CATÁLOGO (o nó só
 * guarda a referência). A consulta é a mesma de todos os cards e do painel: o
 * react-query a faz uma vez só.
 */
function ModeloNoCard({ config }: { config: MessageNodeConfig }) {
  const t = useT();
  const catalogo = useCatalogoDeModelos({ todos: true });
  if (!config.template_name && !config.template_id) {
    return (
      <p className="rounded-md border border-dashed border-border px-2 py-2 text-center text-xs text-text-muted">
        {t("Escolher modelo de mensagem")}
      </p>
    );
  }
  if (!catalogo.data) return null;
  const modelo = acharModeloNoCatalogo(catalogo.data, config);
  if (!modelo) {
    return (
      <p className="rounded-md bg-warning-bg px-2 py-1 text-xs text-warning-fg" data-testid="modelo-nao-localizado">
        {t("Modelo não localizado no catálogo")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {!modelo.utilizavel && (
        <p className="rounded-md bg-error-bg px-2 py-1 text-xs text-error-fg">
          {t("Modelo não aprovado")} ({modelo.status})
        </p>
      )}
      <PreviaDoModelo modelo={modelo} compacta />
    </div>
  );
}

/**
 * Os blocos, dentro do card — como a referência de mercado mostra a sequência:
 * cada texto, "Aguardando por N segundos…", a imagem, e o botão de URL (que
 * não é saída, então aparece aqui e não nas linhas de saída).
 */
function BlocosNoCard({ config }: { config: MessageNodeConfig }) {
  const t = useT();
  const blocos = blocosDaMensagem(config);
  return (
    <div className="flex flex-col gap-1" data-testid="blocos-no-card">
      {blocos.slice(0, 6).map((b) =>
        b.tipo === "texto" ? (
          <div key={b.id} className="rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-snug text-text">
            <p className="line-clamp-2 break-words">{b.texto || t("Sem texto ainda")}</p>
            {(b.botoes ?? [])
              .filter((x) => x.acao === "url")
              .map((x) => (
                <p key={x.id} className="mt-0.5 flex items-center gap-1 truncate text-accent">
                  <LinkSimple size={11} aria-hidden /> {x.rotulo}
                </p>
              ))}
          </div>
        ) : b.tipo === "atraso" ? (
          <p
            key={b.id}
            className="flex items-center gap-1 rounded-md bg-accent-500/10 px-2 py-1 text-[11px] text-accent-700 dark:text-accent-300"
          >
            <Clock size={11} aria-hidden /> {t("Aguardando por")} {rotuloDoAtraso(b.segundos)}…
          </p>
        ) : (
          <p key={b.id} className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] text-text-muted">
            <ImageSquare size={11} aria-hidden /> {b.legenda?.trim() || t("Imagem")}
          </p>
        ),
      )}
      {blocos.length > 6 && <p className="text-[11px] text-text-muted">+{blocos.length - 6}</p>}
    </div>
  );
}

/** "3 s", "2 min", "1 h 30 min" — o mesmo formato no card e no painel. */
export function rotuloDoAtraso(segundos: number): string {
  const s = Math.max(0, Math.round(Number(segundos) || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Um componente só para todos os tipos de passo — o visual (ícone/cor) e o
 * resumo da configuração vêm de `NODE_VISUALS`/`describeNodeConfig`.
 * Registrado no `nodeTypes` do canvas sob cada chave, todas apontando pra cá.
 */
export function GenericFlowNode({ id, type, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const nodeType = type as FlowNodeType;
  const visual = NODE_VISUALS[nodeType];
  const messageConfig = data.config as MessageNodeConfig;
  const semGatilho = nodeType === "TRIGGER" && !(data.config as TriggerNodeConfig).trigger_type;

  return (
    <NodeCard
      id={id}
      visual={visual}
      label={data.label || visual.defaultLabel}
      subtitle={describeNodeConfig(nodeType, data.config)}
      selected={selected}
      errors={data.errors}
      showTarget={nodeType !== "TRIGGER"}
      showSource={nodeType !== "END"}
      handles={saidasDoNo(nodeType, data.config)}
      proximoPasso={nodeType === "MESSAGE" ? t("Próximo passo") : undefined}
    >
      {semGatilho && (
        <p
          className="rounded-md border border-dashed border-accent-400 px-2 py-2 text-center text-xs text-accent"
          data-testid="card-novo-gatilho"
        >
          + {t("Novo gatilho")}
        </p>
      )}
      {nodeType === "MESSAGE" && messageConfig.window_mode === "outside_24h" && <ModeloNoCard config={messageConfig} />}
      {nodeType === "MESSAGE" && messageConfig.window_mode !== "outside_24h" && usaBlocos(messageConfig) && (
        <BlocosNoCard config={messageConfig} />
      )}
    </NodeCard>
  );
}
