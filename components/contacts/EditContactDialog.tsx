"use client";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { EscolherEtiqueta } from "@/components/catalogo/EscolherEtiqueta";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import {
  acrescentarTag,
  campoVazio,
  definirCampo,
  limparCampo,
  removerTag,
  valorParaTela,
} from "@/lib/contacts/ficha-do-contato";
import { cn } from "@/lib/utils";
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  /** `AAAA-MM-DD` — a MESMA forma de `contactPatchSchema` e da coluna do banco. */
  birthdate?: string;
  /** Uma tag por item — nunca mais texto com vírgula (a vírgula no nome partia a tag). */
  tags?: string[];
  custom_fields?: Record<string, unknown>;
}

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Definições vindas de `crm_pipelines.settings.fields[]`. Vazio = a seção some. */
  customFieldDefs?: CustomFieldDef[];
}

export function EditContactDialog({ contact, open, onOpenChange, customFieldDefs = [] }: Props) {
  const t = useT();
  const update = useUpdateContact(contact.id);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
      birthdate: contact.birthdate ?? "",
      tags: [...contact.tags],
      custom_fields: contact.custom_fields ?? {},
    },
  });

  const customFields = useWatch({ control: form.control, name: "custom_fields" });
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        birthdate: contact.birthdate ?? "",
        tags: [...contact.tags],
        custom_fields: contact.custom_fields ?? {},
      });
    }
  }, [open, contact, form]);

  async function onSubmit(values: FormShape) {
    setServerError(null);

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    // Igual aos campos de cima: só manda quando há data. O `type="date"` devolve
    // `AAAA-MM-DD` (a forma que `contactPatchSchema` e a coluna `birthdate` já
    // exigem), então o diálogo não normaliza nada — o que se digita é o que se
    // grava, e a ficha recarregada mostra a MESMA string.
    if (values.birthdate?.trim()) payload.birthdate = values.birthdate.trim();
    // A lista inteira: o PATCH substitui, e é assim que remover um chip chega
    // ao banco. A normalização é a do servidor (`contactPatchSchema`, #1224).
    payload.tags = values.tags ?? [];
    // Sempre no payload, mesmo vazio: o PATCH SUBSTITUI, e é assim que apagar um
    // campo pela tela chega ao banco.
    payload.custom_fields = values.custom_fields ?? {};

    const parsed = contactPatchSchema.safeParse(payload);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? t("Dados inválidos"));
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success(t("Contato atualizado"));
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ═══ TRÊS ZONAS: cabeçalho fixo, meio que rola, rodapé fixo ═══

          MEDIDO, não estimado. Em 1280×800, com os campos personalizados de uma
          organização que declarou vinte, este diálogo ficava com 1563px de
          altura, `overflow-y: visible`, e o botão Salvar em y=1120 — fora da
          tela, sem rolagem, impossível de clicar. Antes do registro de campos
          (migration 0389) isso não aparecia: as definições só vinham do funil e
          eram poucas.

          A primeira tentativa de conserto foi `max-h + overflow-y-auto` no
          contêiner inteiro. Ela devolve o acesso ao botão, e mesmo assim está
          ERRADA: com o diálogo inteiro rolando, o título sai de vista e o
          Salvar só aparece no fim da rolagem — ou seja, quanto mais campos,
          mais longe fica a ação. Trocava "inalcançável" por "escondido".

          O que vale é separar em três: cabeçalho e rodapé `shrink-0`, e só o
          MIOLO com `overflow-y-auto`. Os dois pontos não-óbvios:

            · `min-h-0` no miolo e no form. Item de flex tem `min-height: auto`
              por padrão, que significa "não encolha abaixo do conteúdo" — com
              ele, o miolo continua com 1400px, o contêiner estoura de novo e o
              `overflow-y-auto` não tem o que rolar. É a causa nº 1 de "pus
              overflow e não rolou".
            · `p-0` aqui e padding por zona. O `DialogContent` traz `p-6`; sem
              zerá-lo, a linha que separa o rodapé pararia 24px antes da borda.

          `dvh` e não `vh`: no celular a barra do navegador entra e sai, e `vh`
          congela a altura maior — o rodapé fica atrás da barra justamente
          quando ela reaparece.

          O teto vive no CHAMADOR, e não no `DialogContent` compartilhado: mudar
          o layout do componente base mexeria em todos os diálogos do produto
          por causa deste. Ver a limitação registrada no fim desta sessão. */}
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{t("Editar contato")}</DialogTitle>
          <DialogDescription>{t("Atualize os dados deste contato.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
            <section className="space-y-3" aria-labelledby="ec-sistema">
              <h3 id="ec-sistema" className="text-sm font-medium">
                {t("Campos do sistema")}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="ec-name">{t("Nome")}</Label>
                <Input id="ec-name" {...form.register("name")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ec-email">Email</Label>
                <Input id="ec-email" type="email" {...form.register("email")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ec-phone">{t("Telefone (E.164)")}</Label>
                <Input id="ec-phone" {...form.register("phone_number")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ec-birthdate">{t("Data de nascimento")}</Label>
                <Input id="ec-birthdate" type="date" {...form.register("birthdate")} />
              </div>
            </section>

            <TagsDoContato
              tags={tags}
              onChange={(next) => form.setValue("tags", next, { shouldDirty: true })}
            />

            <CamposPersonalizadosDoContato
              definicoes={customFieldDefs}
              valores={customFields ?? {}}
              onChange={(next) => form.setValue("custom_fields", next, { shouldDirty: true })}
            />
          </div>
          {/* O ERRO fica junto do rodapé, fora da área que rola: uma recusa do
              servidor que aparecesse no meio de vinte campos passaria batida
              exatamente quando mais importa. */}
          <DialogFooter className="shrink-0 flex-col gap-2 border-t border-border px-6 pb-6 pt-4 sm:flex-row sm:items-center">
            {serverError && (
              <p className="mr-auto text-sm text-error-fg">{serverError}</p>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * As TAGS do contato: cada uma um chip com "×", e "+ Adicionar tag" abre a lista
 * pesquisável das tags da organização (registro + as já aplicadas). Adicionar
 * não substitui nada — era um campo de texto com vírgula, em que apagar uma
 * letra a mais levava a tag vizinha junto.
 */
function TagsDoContato({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const t = useT();
  return (
    <section className="space-y-2" aria-labelledby="ec-tags" data-testid="ficha-tags">
      <div className="flex items-center justify-between gap-2">
        <h3 id="ec-tags" className="text-sm font-medium">
          {t("Tags do contato")}
        </h3>
        <EscolherEtiqueta
          jaEscolhidas={tags}
          onEscolher={(nome) => onChange(acrescentarTag(tags, nome))}
          testId="ficha-adicionar-tag"
        />
      </div>
      {tags.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("Nenhuma tag neste contato.")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag}>
              <ChipDeEtiqueta tag={tag} className="h-6 gap-1 px-2 text-xs">
                <button
                  type="button"
                  className="ml-0.5 opacity-70 hover:opacity-100"
                  aria-label={`${t("Remover tag")} ${tag}`}
                  onClick={() => onChange(removerTag(tags, tag))}
                >
                  ×
                </button>
              </ChipDeEtiqueta>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Quantos campos a ficha mostra antes de "Mostrar todos". */
const CAMPOS_VISIVEIS = 6;

/**
 * TODOS os campos personalizados da organização, cada um com o valor deste
 * contato ou "Não definido" — e um clique abre o campo para preencher ali mesmo.
 *
 * As definições vêm do registro (Configurações › Campos do Usuário) somado ao
 * legado do funil (`camposDoContato`): um campo criado depois aparece na ficha
 * sem ninguém precisar declará-lo em outro lugar.
 */
function CamposPersonalizadosDoContato({
  definicoes,
  valores,
  onChange,
}: {
  definicoes: CustomFieldDef[];
  valores: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [editando, setEditando] = useState<string | null>(null);
  const [todos, setTodos] = useState(false);
  const visiveis = todos ? definicoes : definicoes.slice(0, CAMPOS_VISIVEIS);

  return (
    <section className="space-y-2" aria-labelledby="ec-campos" data-testid="ficha-campos">
      <div>
        <h3 id="ec-campos" className="text-sm font-medium">
          {t("Campos personalizados")}
        </h3>
        <Link
          href="/app/settings/contact-fields"
          className="text-xs text-accent-600 underline-offset-4 hover:underline"
        >
          {t("Gerenciar campos personalizados")}
        </Link>
      </div>
      {definicoes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("Nenhum campo personalizado cadastrado ainda.")}</p>
      ) : (
        <ul className="space-y-1.5">
          {visiveis.map((def) => {
            const texto = valorParaTela(def, valores[def.key], t);
            const aberto = editando === def.key;
            return (
              <li key={def.key} data-testid={`campo-${def.key}`}>
                {aberto ? (
                  <div className="space-y-2 rounded-lg border border-accent-300 bg-accent-soft p-2.5">
                    <CustomFieldsEditor
                      fields={[def]}
                      mode="contact"
                      value={valores}
                      onChange={(next) => onChange(definirCampo(valores, def.key, next[def.key]))}
                      className="md:grid-cols-1"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={campoVazio(valores[def.key])}
                        onClick={() => onChange(limparCampo(valores, def.key))}
                      >
                        {t("Limpar")}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditando(null)}>
                        {t("Concluir")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditando(def.key)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-1.5 text-left text-sm transition-colors",
                      texto === null
                        ? "border-border hover:border-accent-300"
                        : "border-accent-200 bg-accent-soft hover:border-accent-300",
                    )}
                    aria-label={`${t("Editar campo")} ${def.label}`}
                  >
                    <span className="text-muted-foreground">{def.label}: </span>
                    {texto === null ? (
                      <span className="text-text-subtle" data-testid="nao-definido">
                        {t("Não definido")}
                      </span>
                    ) : (
                      <span className="break-words">{texto}</span>
                    )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {definicoes.length > CAMPOS_VISIVEIS && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setTodos((v) => !v)}
        >
          {todos ? t("Mostrar menos") : `${t("Mostrar todos")} (${definicoes.length})`}
        </Button>
      )}
    </section>
  );
}
