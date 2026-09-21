import type { ComponentType } from "react";

import { Play, ChatCircle, GitBranch, CheckCircle, Clock, WebhooksLogo, Flag } from "@/lib/ui/icons";
import { acaoPorTipo, acoesDoNo } from "@/lib/flows/acoes";
import type { ActionNodeConfig } from "@/lib/flows/types";
import { resumoDoGatilho } from "@/lib/flows/triggers";
import type { FlowNodeType, MessageNodeConfig, TriggerNodeConfig } from "@/lib/flows/types";

export interface NodeVisual {
  type: FlowNodeType;
  paletteLabel: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  chipClassName: string;
  borderClassName: string;
  defaultLabel: string;
  defaultConfig: () => Record<string, unknown>;
  /** O gatilho nasce com o flow e é único — não entra na lista de passos novos. */
  paletteVisible?: boolean;
}

export const NODE_VISUALS: Record<FlowNodeType, NodeVisual> = {
  TRIGGER: {
    type: "TRIGGER",
    paletteLabel: "Quando…",
    icon: Play,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Quando…",
    defaultConfig: () => ({ trigger_type: "contact_tag_added", config: {} }),
    paletteVisible: false,
  },
  MESSAGE: {
    type: "MESSAGE",
    paletteLabel: "Mensagem",
    icon: ChatCircle,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => ({ body: "", buttons: [], window_mode: "inside_24h" }),
  },
  ACTION: {
    type: "ACTION",
    paletteLabel: "Ação",
    icon: CheckCircle,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Executar ação",
    defaultConfig: () => ({ actions: [{ action_type: "add_tag", config: { tags: [] } }] }),
  },
  CONDITION: {
    type: "CONDITION",
    paletteLabel: "Condição",
    icon: GitBranch,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Verificar condição",
    defaultConfig: () => ({ checks: [{ field: "contact.tags", op: "contains", value: "" }] }),
  },
  DELAY: {
    type: "DELAY",
    paletteLabel: "Aguardar",
    icon: Clock,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Aguardar",
    defaultConfig: () => ({ duration_ms: 5 * 60 * 1000 }),
  },
  WEBHOOK: {
    type: "WEBHOOK",
    paletteLabel: "Webhook",
    icon: WebhooksLogo,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Chamar webhook",
    defaultConfig: () => ({ url: "" }),
  },
  END: {
    type: "END",
    paletteLabel: "Fim",
    icon: Flag,
    chipClassName: "bg-error-bg text-error-fg",
    borderClassName: "border-l-error",
    defaultLabel: "Fim do fluxo",
    defaultConfig: () => ({}),
  },
};

/** Duração legível — o card mostra "2 h", não "7200000 ms". */
export function duracaoLegivel(ms: number): string {
  if (ms >= 86_400_000) {
    const dias = Math.round(ms / 86_400_000);
    return `${dias} ${dias === 1 ? "dia" : "dias"}`;
  }
  if (ms >= 3_600_000) {
    const horas = Math.round(ms / 3_600_000);
    return `${horas} ${horas === 1 ? "hora" : "horas"}`;
  }
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} min`;
}

export function describeNodeConfig(type: FlowNodeType, config: Record<string, unknown>): string {
  switch (type) {
    case "TRIGGER": {
      const cfg = config as TriggerNodeConfig;
      return resumoDoGatilho(cfg.trigger_type ?? "", cfg.config ?? {});
    }
    case "MESSAGE": {
      const cfg = config as MessageNodeConfig;
      if (cfg.window_mode === "outside_24h") {
        return cfg.template_name ? `Template: ${cfg.template_name}` : "Fora da janela — falta o template";
      }
      return cfg.body?.trim() ? cfg.body : "Sem texto ainda";
    }
    case "CONDITION": {
      const checks = Array.isArray(config.checks) ? config.checks : [];
      return checks.length ? `${checks.length} condição(ões)` : "Sem condição ainda";
    }
    case "ACTION": {
      // O nó carrega uma LISTA. O resumo enumera as duas primeiras e conta o
      // resto: o card tem duas linhas, e um nó com cinco ações que mostrasse só
      // a primeira mentiria sobre o que ele faz.
      const acoes = acoesDoNo(config as ActionNodeConfig);
      if (acoes.length === 0) return "Sem ação escolhida";
      const rotulos = acoes.map((a) => acaoPorTipo(a.action_type)?.label ?? a.action_type);
      if (rotulos.length <= 2) return rotulos.join(" · ");
      return `${rotulos.slice(0, 2).join(" · ")} · +${rotulos.length - 2}`;
    }
    case "DELAY":
      return duracaoLegivel(Number(config.duration_ms) || 0);
    case "WEBHOOK":
      return typeof config.url === "string" && config.url ? config.url : "Sem URL ainda";
    case "END":
      return "Encerra a execução";
    default:
      return "";
  }
}
