"use client";
/**
 * AS ETIQUETAS QUE UM SELETOR OFERECE — registro + vocabulário, numa lista só.
 *
 * São duas fontes, e ler só uma delas foi o defeito medido no público dos
 * Disparos: o seletor lia apenas o REGISTRO (`/api/v1/tags`, o que a organização
 * declarou), e numa organização cujas etiquetas foram aplicadas nos contatos sem
 * nunca serem declaradas (importação, automação, API) o registro vem vazio — o
 * menu abria sem nenhum item, e o `Select` vazio virava uma barra fina fora do
 * lugar. O VOCABULÁRIO (`/api/v1/contact-tags`) é o que já está aplicado.
 *
 * A união deduplica sem diferenciar maiúsculas: o nome do registro vence (é a
 * grafia declarada); o do vocabulário entra quando só existe lá.
 */
import { useMemo } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useTags } from "@/hooks/catalogo/useCatalogo";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";

export interface OpcoesDeEtiqueta {
  /** Nomes em ordem alfabética, sem repetição (sem diferenciar maiúsculas). */
  opcoes: string[];
  /** Os nomes (minúsculos) que vieram do registro. */
  doRegistro: Set<string>;
  carregando: boolean;
}

export function juntarEtiquetas(
  registro: readonly string[],
  vocabulario: readonly string[],
): { opcoes: string[]; doRegistro: Set<string> } {
  const porChave = new Map<string, string>();
  const doRegistro = new Set<string>();
  for (const nome of registro) {
    const chave = nome.trim().toLowerCase();
    if (!chave) continue;
    doRegistro.add(chave);
    if (!porChave.has(chave)) porChave.set(chave, nome.trim());
  }
  for (const nome of vocabulario) {
    const chave = nome.trim().toLowerCase();
    if (!chave || porChave.has(chave)) continue;
    porChave.set(chave, nome.trim());
  }
  const opcoes = [...porChave.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return { opcoes, doRegistro };
}

export function useOpcoesDeEtiqueta(): OpcoesDeEtiqueta {
  const { activeOrg } = useAuth();
  const registro = useTags();
  const vocabulario = useContactTagVocabulary(activeOrg?.orgId ?? null);
  const nomesDoRegistro = registro.data;
  const nomesDoVocabulario = vocabulario.data;
  const { opcoes, doRegistro } = useMemo(
    () =>
      juntarEtiquetas(
        (nomesDoRegistro ?? []).map((t) => t.name),
        nomesDoVocabulario ?? [],
      ),
    [nomesDoRegistro, nomesDoVocabulario],
  );
  return {
    opcoes,
    doRegistro,
    carregando: (registro.isLoading && !nomesDoRegistro) || (vocabulario.isLoading && !nomesDoVocabulario),
  };
}
