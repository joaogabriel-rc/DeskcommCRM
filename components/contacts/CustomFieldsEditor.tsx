"use client";
/**
 * CustomFieldsEditor — recebe uma lista de definições e renderiza o input certo
 * por tipo. Usado pelo dossiê do contato, pelo painel do inbox e pelo dossiê do
 * negócio, via `LeadFieldsForm`.
 *
 * ── De onde vêm as definições ───────────────────────────────────────────────
 *
 * Do CHAMADOR, e isso é deliberado: para o NEGÓCIO elas saem de
 * `crm_pipelines.settings.fields[]` (são campos daquele funil), e para o
 * CONTATO saem de `camposDoContato()` (lib/contacts/campos-do-contato.ts), que
 * junta o registro `public.contact_fields` com o legado do funil. Este
 * componente não sabe de onde vieram e não deve saber — é ele que desenha, não
 * que decide.
 *
 * ── `datetime` e `list` entraram com o registro (migration 0383) ────────────
 *
 * São dois dos seis tipos que a tela de Campos do Usuário oferece. Sem eles
 * aqui, um campo criado como "Data e hora" cairia no `default` do switch e
 * viraria caixa de texto — o operador digitaria o formato que quisesse e a
 * condição do flow que compara data nunca casaria.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export type CustomFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "boolean"
  | "list"
  | "email"
  | "phone"
  | "url";

export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

interface Props {
  fields: CustomFieldDef[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: "lead" | "contact";
  disabled?: boolean;
  className?: string;
}

export function CustomFieldsEditor({ fields, value, onChange, disabled, className }: Props) {
  const t = useT();
  function set(key: string, v: unknown) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2", className)}>
      {fields.map((f) => {
        const v = value[f.key];
        const id = `cf-${f.key}`;

        const labelEl = (
          <Label htmlFor={id}>
            {f.label}
            {f.required && <span className="ml-1 text-error-fg">*</span>}
          </Label>
        );

        switch (f.type) {
          case "textarea":
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                {labelEl}
                <Textarea
                  id={id}
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "number":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="number"
                  value={typeof v === "number" ? v : ""}
                  onChange={(e) =>
                    set(f.key, e.target.value === "" ? null : Number(e.target.value))
                  }
                  disabled={disabled}
                />
              </div>
            );
          case "date":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="date"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "datetime":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="datetime-local"
                  // O valor vai e volta como a string que o `datetime-local`
                  // produz (`2026-09-20T14:30`), sem passar por `new Date()`.
                  // Converter para ISO aqui gravaria o instante em UTC e o
                  // campo reabriria com outra hora para quem não está em UTC —
                  // e o que o operador digitou é a hora LOCAL dele.
                  value={typeof v === "string" ? v.slice(0, 16) : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "list": {
            // "Matriz": uma lista de textos livres. Sem opções declaradas, ao
            // contrário de `multiselect` — quem escolhe os valores é quem
            // preenche, não quem cadastrou o campo.
            const itens = Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                {labelEl}
                <Textarea
                  id={id}
                  rows={3}
                  // Uma linha por item. Textarea e não N inputs: o número de
                  // itens é livre, e um editor com botões de adicionar/remover
                  // seria um componente inteiro para o que uma quebra de linha
                  // resolve — e colar uma lista de fora passa a funcionar.
                  value={itens.join("\n")}
                  onChange={(e) =>
                    set(
                      f.key,
                      e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t("Um item por linha.")}</p>
              </div>
            );
          }
          case "select":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Select
                  value={typeof v === "string" ? v : ""}
                  onValueChange={(val) => set(f.key, val)}
                  disabled={disabled}
                >
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t("Selecione…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          case "multiselect": {
            const current = Array.isArray(v) ? (v as string[]) : [];
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <div className="flex flex-col gap-1">
                  {f.options?.map((o) => {
                    const checked = current.includes(o.value);
                    return (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...current, o.value]
                              : current.filter((x) => x !== o.value);
                            set(f.key, next);
                          }}
                          disabled={disabled}
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          }
          case "boolean":
            return (
              <div key={f.key} className="flex items-center justify-between gap-4 md:col-span-2">
                {labelEl}
                <Switch
                  id={id}
                  checked={Boolean(v)}
                  onCheckedChange={(c) => set(f.key, c)}
                  disabled={disabled}
                />
              </div>
            );
          case "email":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="email"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "phone":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="tel"
                  placeholder="+5511999998888"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t("Formato E.164")}</p>
              </div>
            );
          case "url":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="url"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "text":
          default:
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="text"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
        }
      })}
    </div>
  );
}
