"use client";

/**
 * O botão "Inserir variável" que fica ao lado de um campo de texto.
 *
 * ── Por que a tela precisa disto ────────────────────────────────────────────
 *
 * A variável é `{{contact.custom_fields.produto_interesse}}` — 41 caracteres,
 * com dois pares de chaves, um ponto no meio e uma chave que o operador escolheu
 * há três semanas. Digitada à mão ela erra, e o erro é MUDO: o resolvedor troca
 * o que não encontra por string vazia, então a mensagem sai "Seu produto de
 * interesse é:" e ponto. Não há erro para ninguém ver — nem no envio, nem no
 * log, nem no histórico do contato.
 *
 * ── O que ele oferece ───────────────────────────────────────────────────────
 *
 * Os campos fixos do contato e TODOS os campos do registro da organização
 * (migration 0383), pelo nome que a pessoa deu, inserindo a chave correta. É a
 * única coisa aqui que garante que o que está escrito na mensagem corresponde a
 * algo que existe.
 */
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCamposDoContato } from "@/hooks/catalogo/useCatalogo";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { Plus } from "@/lib/ui/icons";

/**
 * Os campos FIXOS do contato, com os apelidos que o resolvedor do flow entende
 * (`lib/flows/template.ts` mapeia `contact.phone` → `phone_number`).
 */
// Os rótulos passam por `t()` no ponto de RENDERIZAÇÃO (ItemDeVariavel), e
// não aqui: traduzir numa constante de módulo congelaria o idioma no primeiro
// import, e quem trocasse de idioma continuaria vendo o anterior.
const FIXAS: Array<{ label: string; variavel: string }> = [
  { label: "Nome", variavel: "{{contact.name}}" },
  { label: "Nome de exibição", variavel: "{{contact.display_name}}" },
  { label: "Telefone", variavel: "{{contact.phone}}" },
  { label: "E-mail", variavel: "{{contact.email}}" },
  { label: "WhatsApp", variavel: "{{contact.whatsapp_id}}" },
];

export function InserirVariavel({ onInserir }: { onInserir: (variavel: string) => void }) {
  const t = useT();
  const { data: campos = [] } = useCamposDoContato();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus size={14} aria-hidden className="mr-1" /> {t("Inserir variável")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="max-h-80 overflow-y-auto">
          <Grupo titulo={t("Do contato")}>
            {FIXAS.map((v) => (
              <ItemDeVariavel key={v.variavel} {...v} onInserir={onInserir} />
            ))}
          </Grupo>
          <Grupo titulo={t("Campos do usuário")}>
            {campos.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-muted">
                {t("Nenhum campo cadastrado. Crie em Configurações › Campos do Usuário.")}
              </p>
            ) : (
              campos.map((campo) => (
                <ItemDeVariavel
                  key={campo.id}
                  label={campo.label}
                  variavel={`{{contact.custom_fields.${campo.key}}}`}
                  onInserir={onInserir}
                />
              ))
            )}
          </Grupo>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Grupo({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <p className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-text-muted">{titulo}</p>
      {children}
    </div>
  );
}

function ItemDeVariavel({
  label,
  variavel,
  onInserir,
}: {
  label: string;
  variavel: string;
  onInserir: (v: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onInserir(variavel)}
      className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-muted"
    >
      <span className="text-sm">{t(label)}</span>
      <code className="text-xs text-text-muted">{variavel}</code>
    </button>
  );
}
