"use client";

/**
 * Os seletores que leem os REGISTROS da organização (migration 0312).
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
import { useMemo } from "react";

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
        <SelectTrigger id={id}>
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
 * Seletor de ETIQUETAS. Múltiplas, com sugestão do registro.
 *
 * `datalist` em vez de um multi-select desenhado à mão: a etiqueta é texto
 * livre no banco (`contacts.tags text[]`), então o campo TEM de aceitar o que
 * não está na lista — e um multi-select que também aceita texto novo é um
 * componente inteiro para resolver o que uma `datalist` resolve.
 */
export function SeletorDeTags({
  valor,
  onChange,
  id,
  placeholder,
}: {
  valor: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  placeholder?: string;
}) {
  const t = useT();
  const { data: tags = [] } = useTags();
  const listaId = `tags-do-registro-${id ?? "padrao"}`;

  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        list={listaId}
        value={valor.join(", ")}
        placeholder={placeholder ?? "CLIENTE, VIP"}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
      <datalist id={listaId}>
        {tags.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
      <p className="text-xs text-text-muted">
        {t("Separe por vírgula. As tags cadastradas aparecem como sugestão ao digitar.")}
      </p>
    </div>
  );
}
