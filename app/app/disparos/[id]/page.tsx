/**
 * Canais → Disparos → um disparo.
 *
 * Três blocos, na ordem em que a decisão acontece: PÚBLICO (quem), MENSAGEM (o
 * quê), AGENDAMENTO (quando) — e, depois de agendado, o ANDAMENTO.
 */
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { fluxoDoDisparo } from "@/lib/disparos/fluxo-do-disparo";
import type { DisparoRow } from "@/lib/schemas/disparos";
import { createClient } from "@/lib/supabase/server";

import { DisparoEditor } from "./_components/DisparoEditor";

export const dynamic = "force-dynamic";

export default async function DisparoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!data) notFound();
  const fluxo = await fluxoDoDisparo(supabase, activeOrg.orgId, id).catch(() => null);

  return (
    <DisparoEditor
      inicial={{ ...(data as unknown as DisparoRow), modo: fluxo ? "fluxo" : "guiado", fluxo, problemas: [] }}
    />
  );
}
