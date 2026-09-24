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

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCamposDoContato, useTags } from "@/hooks/catalogo/useCatalogo";
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
        value={foraDoRegistro || !valor ? OUTRO : valor}
        onValueChange={(v) => onChange(v === OUTRO ? valor : v)}
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
          <SelectItem value={OUTRO}>Outra chave (digitar)</SelectItem>
        </SelectContent>
      </Select>
      {(foraDoRegistro || !valor) && (
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
  /** `false` = só etiquetas do registro (público de disparo). */
  permitirNova?: boolean;
}) {
  const t = useT();
  const { data: tags = [] } = useTags();
  const [nova, setNova] = useState("");
  const escolhidas = new Set(valor.map((v) => v.toLowerCase()));
  const disponiveis = tags.filter((tag) => !escolhidas.has(tag.name.toLowerCase()));

  function acrescentar(nome: string) {
    const limpo = nome.trim();
    if (!limpo || escolhidas.has(limpo.toLowerCase())) return;
    onChange([...valor, limpo]);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={id ? `seletor-de-tags-${id}` : undefined}>
      {valor.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {valor.map((nome) => {
            const doRegistro = tags.some((tag) => tag.name.toLowerCase() === nome.toLowerCase());
            return (
              <li
                key={nome}
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-xs"
                title={doRegistro ? undefined : t("Etiqueta fora do registro")}
              >
                <span className={doRegistro ? "" : "italic text-text-muted"}>{nome}</span>
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
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select value="" onValueChange={acrescentar}>
          <SelectTrigger id={id} className="w-56" aria-label={t("Adicionar etiqueta")}>
            <SelectValue placeholder={disponiveis.length ? t("Adicionar etiqueta") : t("Nenhuma etiqueta a adicionar")} />
          </SelectTrigger>
          <SelectContent>
            {disponiveis.map((tag) => (
              <SelectItem key={tag.id} value={tag.name}>
                {tag.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {permitirNova && (
          <Input
            className="w-44"
            value={nova}
            placeholder={t("Nova etiqueta")}
            aria-label={t("Nova etiqueta")}
            onChange={(e) => setNova(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                acrescentar(nova);
                setNova("");
              }
            }}
          />
        )}
      </div>
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
