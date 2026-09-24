import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import type { FlowRow } from "@/hooks/flows/useFlows";
import { FlowsList } from "./_components/FlowsList";

export const dynamic = "force-dynamic";

export default async function FlowsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const { data } = await supabase
    .from("flows")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    // Fluxo de disparo (0399) mora no disparo, não em Automações.
    .is("broadcast_id", null)
    .order("created_at", { ascending: false });

  const flows = (data ?? []) as FlowRow[];
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Fluxos")}</h1>
        <p className="text-sm text-text-muted">
          {t(
            "Automações visuais de WhatsApp: você escolhe o gatilho que inicia o fluxo e monta os passos — mensagens, botões que abrem caminhos, ações, esperas e webhooks.",
          )}
        </p>
      </header>
      <FlowsList initialData={flows} canWrite={canWrite} />
    </div>
  );
}
