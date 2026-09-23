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
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  tagsRaw?: string;
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
      tagsRaw: contact.tags.join(", "),
      custom_fields: contact.custom_fields ?? {},
    },
  });

  const customFields = useWatch({ control: form.control, name: "custom_fields" });

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        tagsRaw: contact.tags.join(", "),
        custom_fields: contact.custom_fields ?? {},
      });
    }
  }, [open, contact, form]);

  async function onSubmit(values: FormShape) {
    setServerError(null);
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags((values.tagsRaw ?? "").split(","));

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    payload.tags = tags;
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
              <Label htmlFor="ec-tags">Tags</Label>
              <Input id="ec-tags" {...form.register("tagsRaw")} />
            </div>
            {customFieldDefs.length > 0 && (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">{t("Campos personalizados")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t("Campos declarados em Configurações › Campos do Usuário, mais os do funil.")}
                  </p>
                </div>
                <CustomFieldsEditor
                  fields={customFieldDefs}
                  mode="contact"
                  value={customFields ?? {}}
                  onChange={(next) => form.setValue("custom_fields", next, { shouldDirty: true })}
                />
              </div>
            )}
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
