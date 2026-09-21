/**
 * Automações → Disparos. A lista de envios em massa.
 *
 * ── Por que aqui, e não em Canais ───────────────────────────────────────────
 *
 * "Canais" responde por ONDE a mensagem entra e sai. Disparo é trabalho que
 * acontece sem ninguém clicando — irmão do Fluxo, não do número de WhatsApp.
 * Os dois moram no grupo Automações (ver `lib/navigation/catalogo.ts`).
 *
 * ── Por que a lista mostra o ANDAMENTO, e não só o nome ─────────────────────
 *
 * A pergunta que traz alguém a esta tela é "o de ontem terminou?", não "quais
 * existem". Enviados / falhas / pulados na linha respondem sem abrir nada.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { DisparoRow } from "@/lib/schemas/disparos";
import { createClient } from "@/lib/supabase/server";

import { DisparosList } from "./_components/DisparosList";

export const metadata = { title: "Disparos" };
export const dynamic = "force-dynamic";

export default async function DisparosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const { data } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Disparos")}</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          {t(
            "Envio de WhatsApp em massa para um público filtrado por tag e por campo do usuário. O envio sai aos poucos, no ritmo que protege o número — e ninguém recebe duas vezes.",
          )}
        </p>
      </header>
      <DisparosList initialData={(data ?? []) as unknown as DisparoRow[]} />
    </div>
  );
}
