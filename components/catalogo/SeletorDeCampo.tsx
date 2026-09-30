"use client";

/**
 * Os seletores que leem os REGISTROS da organização (migration 0389).
 *
 * Moram em `components/` e não dentro da tela de fluxos porque três telas
 * precisam exatamente dos mesmos: o painel do nó ACTION, o construtor de
 * segmento dos Disparos e o editor de condição. Um seletor por tela seria
 * três listas que divergem no dia em que uma delas ganhar "mostrar
 * arquivados".
 *
 * ── Todos aceitam valor FORA do registro ────────────────────────────────────
 *
 * E isso é deliberado, não descuido. Um flow salvo antes desta fatia tem a
 * chave digitada à mão; um contato importado tem etiqueta que ninguém cadastrou.
 * Se o seletor descartasse o que não está na lista, abrir a configuração
 * antiga APAGARIA em silêncio o que estava lá. Então o valor atual sempre
 * aparece — marcado como "fora do registro" quando for o caso.
 */
import { useMemo, useState } from "react";

import { EscolherEtiqueta } from "@/components/catalogo/EscolherEtiqueta";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCamposDoContato } from "@/hooks/catalogo/useCatalogo";
import { useOpcoesDeEtiqueta } from "@/hooks/catalogo/useOpcoesDeEtiqueta";
import { useT } from "@/lib/i18n/IdiomaProvider";

/** Valor sentinela do item "digitar outra chave" — `SelectItem` não aceita "". */
const OUTRO = "__outro__";

export function SeletorDeCampo({
  valor,
  onChange,
  id,
}: {
  valor: string;
  onChange: (chave: string) => void;
  id?: string;
}) {
  const t = useT();
  const { data: campos = [], isLoading } = useCamposDoContato();

  const foraDoRegistro = useMemo(
    () => !!valor && !campos.some((c) => c.key === valor),
    [campos, valor],
  );
  // "Outra chave" só quando a pessoa ESCOLHE digitar. Antes, campo ainda vazio
  // já mostrava "Outra chave (digitar)" selecionado e uma caixa de chave
  // técnica aberta — a primeira coisa que o critério novo pedia era um
  // identificador de banco, no lugar de "escolha o campo".
  const [digitando, setDigitando] = useState(false);
  const mostrarChave = foraDoRegistro || (digitando && !campos.some((c) => c.key === valor));

  if (isLoading && campos.length === 0) {
    return <Input id={id} value={valor} onChange={(e) => onChange(e.target.value)} disabled />;
  }

  if (campos.length === 0) {
    // Sem nada cadastrado, um `select` vazio seria um beco: a tela diria
    // "escolha" sem nada para escolher. Volta a ser texto, com o caminho.
    return (
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          className="font-mono"
          value={valor}
          placeholder="produto_interesse"
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="text-xs text-text-muted">
          {t("Nenhum campo cadastrado ainda. Crie em Configurações › Campos do Usuário para escolher de uma lista em vez de digitar.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Select
        value={mostrarChave ? OUTRO : valor || undefined}
        onValueChange={(v) => {
          if (v === OUTRO) {
            setDigitando(true);
            return;
          }
          setDigitando(false);
          onChange(v);
        }}
      >
        <SelectTrigger id={id} aria-label={t("Campo")}>
          <SelectValue placeholder={t("Escolha o campo")} />
        </SelectTrigger>
        <SelectContent>
          {campos.map((campo) => (
            <SelectItem key={campo.id} value={campo.key}>
              {campo.label}
            </SelectItem>
          ))}
          <SelectItem value={OUTRO}>{t("Outra chave (digitar)")}</SelectItem>
        </SelectContent>
      </Select>
      {mostrarChave && (
        <Input
          className="font-mono"
          value={valor}
          placeholder="produto_interesse"
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("Chave do campo")}
        />
      )}
      {foraDoRegistro && (
        <p className="text-xs text-text-muted">
          {t("Esta chave não está no registro de campos. Ela funciona, mas não aparece nos seletores das outras telas.")}
        </p>
      )}
    </div>
  );
}

/**
 * Seletor de ETIQUETAS. Múltiplas, cada uma um chip, escolhidas do REGISTRO.
 *
 * ── Por que não é mais um campo de texto com vírgula ─────────────────────────
 *
 * A primeira versão juntava a lista com ", " e separava de volta pela vírgula.
 * Uma etiqueta que tem vírgula no nome ("Cliente, VIP") virava duas ao abrir a
 * tela — e o segmento que saía dali filtrava por etiquetas que não existem.
 * Chip por etiqueta não tem separador para confundir.
 *
 * ── `permitirNova` ──────────────────────────────────────────────────────────
 *
 * O nó de AÇÃO precisa poder aplicar uma etiqueta que ainda não foi cadastrada
 * (é assim que ela nasce); o público de um disparo, não — filtrar por etiqueta
 * que ninguém tem só esvazia o público. Quem usa escolhe.
 *
 * O valor atual SEMPRE aparece, mesmo fora do registro (ver o cabeçalho do
 * arquivo): abrir uma configuração antiga não apaga nada.
 */
export function SeletorDeTags({
  valor,
  onChange,
  id,
  permitirNova = true,
}: {
  valor: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  /** @deprecated Sem efeito desde o seletor por chips. */
  placeholder?: string;
  /** `false` = só etiquetas que já existem (público de disparo). */
  permitirNova?: boolean;
}) {
  const t = useT();
  // Registro + vocabulário (`useOpcoesDeEtiqueta`): ler só o registro deixava o
  // menu VAZIO numa organização cujas etiquetas nunca foram declaradas.
  const { opcoes, doRegistro } = useOpcoesDeEtiqueta();
  const conhecidas = new Set(opcoes.map((o) => o.toLowerCase()));

  function acrescentar(nome: string) {
    const limpo = nome.trim();
    if (!limpo || valor.some((v) => v.toLowerCase() === limpo.toLowerCase())) return;
    onChange([...valor, limpo]);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={id ? `seletor-de-tags-${id}` : undefined}>
      <ul className="flex flex-wrap items-center gap-1.5">
        {valor.map((nome) => {
          const conhecida = conhecidas.has(nome.toLowerCase()) || doRegistro.has(nome.toLowerCase());
          return (
            <li
              key={nome}
              className="flex items-center gap-1 rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 text-xs"
              title={conhecida ? undefined : t("Etiqueta fora do registro")}
            >
              <span className={conhecida ? "" : "italic text-text-muted"}>{nome}</span>
              <button
                type="button"
                className="text-text-muted hover:text-text"
                aria-label={`${t("Remover etiqueta")} ${nome}`}
                onClick={() => onChange(valor.filter((v) => v !== nome))}
              >
                ×
              </button>
            </li>
          );
        })}
        <li>
          <EscolherEtiqueta
            jaEscolhidas={valor}
            onEscolher={acrescentar}
            permitirNova={permitirNova}
            rotulo={t("Adicionar etiqueta")}
            testId={id ? `adicionar-etiqueta-${id}` : undefined}
          />
        </li>
      </ul>
    </div>
  );
}

/**
 * O VALOR de um critério de campo, no controle que o TIPO do campo pede: lista
 * para `select`, sim/não para `boolean`, número e data para os seus tipos,
 * texto para o resto — e texto também para chave fora do registro.
 */
export function ValorDoCampo({
  chave,
  valor,
  onChange,
}: {
  chave: string;
  valor: string;
  onChange: (valor: string) => void;
}) {
  const t = useT();
  const { data: campos = [] } = useCamposDoContato();
  const campo = campos.find((c) => c.key === chave);
  const rotulo = t("Valor");

  if (campo && (campo.type === "select" || campo.type === "multiselect" || campo.type === "list") && campo.options.length) {
    return (
      <Select value={valor || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-44" aria-label={rotulo}>
          <SelectValue placeholder={t("Escolha o valor")} />
        </SelectTrigger>
        <SelectContent>
          {campo.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (campo?.type === "boolean") {
    return (
      <Select value={valor || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-44" aria-label={rotulo}>
          <SelectValue placeholder={t("Escolha o valor")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">{t("Sim")}</SelectItem>
          <SelectItem value="false">{t("Não")}</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const tipoDoInput = campo?.type === "number" ? "number" : campo?.type === "date" ? "date" : "text";
  return (
    <Input
      className="w-44"
      type={tipoDoInput}
      value={valor}
      aria-label={rotulo}
      placeholder={t("valor")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
