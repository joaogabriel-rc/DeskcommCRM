/**
 * Variáveis `{{contact.*}}` do Flow Builder — mesmo motor de
 * `lib/automation/template.ts` (resolveField faz dot-path em qualquer
 * profundidade, então `contact.custom_fields.campo` já funciona sem código
 * extra), com os apelidos que o produto pede: `phone`/`whatsapp_id` em vez dos
 * nomes de coluna reais.
 */
import { resolveField } from "@/lib/automation/conditions";

const ALIASES: Record<string, string> = {
  "contact.phone": "contact.phone_number",
  "contact.whatsapp_id": "contact.wa_identity",
};

export function renderFlowTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const resolved = resolveField(context, ALIASES[path] ?? path);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}
