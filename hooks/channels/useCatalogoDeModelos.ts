"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ConexaoComModelos, ModeloDoCatalogo } from "@/lib/channels/catalogo-de-modelos";

export interface CatalogoDeModelos {
  conexoes: ConexaoComModelos[];
  modelos: ModeloDoCatalogo[];
}

/**
 * O catálogo central de modelos aprovados (`/api/v1/channels/catalogo-de-modelos`).
 *
 * `todos: true` traz também os não aprovados. O card do nó usa assim: um modelo
 * que JÁ foi escolhido e depois foi pausado ou reprovado precisa continuar
 * aparecendo — com o estado dele —, e não sumir como se nunca tivesse existido.
 * O seletor filtra `utilizavel` na tela.
 */
export function useCatalogoDeModelos(opts: { todos?: boolean; enabled?: boolean } = {}) {
  const todos = opts.todos ?? true;
  return useQuery({
    queryKey: ["channel-template-catalog", todos ? "todos" : "utilizaveis"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: CatalogoDeModelos }>(
        `/api/v1/channels/catalogo-de-modelos${todos ? "?todos=1" : ""}`,
      );
      return res.data;
    },
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * Os botões de RESPOSTA RÁPIDA do modelo, na ordem em que a plataforma os
 * declara. São os únicos que viram SAÍDA do nó de mensagem: o clique volta como
 * mensagem do contato com o texto do botão, e o motor a casa pelo mesmo
 * `casarRespostaDeBotao` dos botões digitados. Botão de URL, telefone ou código
 * abre algo no celular e não volta — não há caminho a seguir por ele.
 */
export function respostasRapidas(modelo: Pick<ModeloDoCatalogo, "conteudo">): string[] {
  return modelo.conteudo.botoes.filter((b) => b.tipo === "QUICK_REPLY").map((b) => b.texto);
}

/**
 * O patch de configuração do nó quando o operador ESCOLHE um modelo.
 *
 * - `template_id` é a referência; nome, idioma e `template_contract_hash` são o
 *   retrato (o envio usa nome e idioma; o hash detecta mudança posterior).
 * - `channel_session_id` fixa a conexão: o modelo é aprovado POR CONTA, e o
 *   motor precisa mandar pela conta que o aprovou.
 * - `template_values` passa a ter exatamente as chaves do contrato (`valueKey`):
 *   o valor que já estava na mesma chave fica; link de mídia salvo no modelo
 *   preenche o que estiver vazio; chave que o modelo novo não tem sai.
 * - `buttons` são as respostas rápidas do modelo — as saídas do nó.
 */
export function configDoModeloEscolhido(
  modelo: ModeloDoCatalogo,
  conexaoId: string | null,
  valoresAtuais: Record<string, string>,
): Record<string, unknown> {
  const template_values: Record<string, string> = {};
  for (const e of modelo.espacos) {
    template_values[e.valueKey] = valoresAtuais[e.valueKey] ?? modelo.savedValues[e.valueKey] ?? "";
  }
  return {
    template_id: modelo.id,
    template_name: modelo.name,
    template_language: modelo.language,
    template_contract_hash: modelo.contractHash,
    channel_session_id: modelo.channelSessionId ?? conexaoId ?? undefined,
    template_values,
    buttons: respostasRapidas(modelo).map((label) => ({ label })),
  };
}

/**
 * O modelo que a configuração de um nó aponta, no catálogo já carregado — a
 * mesma regra de `resolverModelo` no servidor: pelo id quando existe; nó antigo,
 * que só guarda nome e idioma, pelo par (recortado pela conexão, se houver).
 */
export function acharModeloNoCatalogo(
  catalogo: CatalogoDeModelos | undefined,
  ref: { template_id?: string; template_name?: string; template_language?: string; channel_session_id?: string },
): ModeloDoCatalogo | null {
  if (!catalogo) return null;
  if (ref.template_id) return catalogo.modelos.find((m) => m.id === ref.template_id) ?? null;
  const name = ref.template_name?.trim();
  const language = ref.template_language?.trim();
  if (!name || !language) return null;
  const conexao = ref.channel_session_id
    ? catalogo.conexoes.find((c) => c.id === ref.channel_session_id)
    : undefined;
  return (
    catalogo.modelos.find(
      (m) =>
        m.name === name &&
        m.language === language &&
        (!ref.channel_session_id ||
          m.channelSessionId === ref.channel_session_id ||
          (m.channelSessionId === null && !!conexao?.wabaId && m.wabaId === conexao.wabaId)),
    ) ?? null
  );
}
