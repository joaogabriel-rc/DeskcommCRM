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

/**
 * Campos CALCULADOS do contato: o contato tem um `name` só, e "Primeiro nome" /
 * "Sobrenome" são pedidos de toda mensagem de marketing. Derivar aqui evita uma
 * coluna que precisaria de sincronização (DIRC: calcular).
 */
function calculado(path: string, context: Record<string, unknown>): string | undefined {
  if (path !== "contact.first_name" && path !== "contact.last_name") return undefined;
  const nome = resolveField(context, "contact.name");
  const partes = typeof nome === "string" ? nome.trim().split(/\s+/).filter(Boolean) : [];
  return path === "contact.first_name" ? (partes[0] ?? "") : partes.slice(1).join(" ");
}

export function renderFlowTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const derivado = calculado(path, context);
    if (derivado !== undefined) return derivado;
    const resolved = resolveField(context, ALIASES[path] ?? path);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}
