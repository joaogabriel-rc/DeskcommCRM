import { redirect } from "next/navigation";
import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { CaretLeft } from "@/lib/ui/icons";
import type { FlowDetailRow } from "@/hooks/flows/useFlow";
import { FlowBuilder } from "./_components/FlowBuilder";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FlowDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const [{ data: flow }, { data: nodes }, { data: edges }] = await Promise.all([
    supabase.from("flows").select("*").eq("id", id).eq("organization_id", activeOrg.orgId).maybeSingle(),
    supabase.from("flow_nodes").select("*").eq("flow_id", id).eq("organization_id", activeOrg.orgId),
    supabase.from("flow_edges").select("*").eq("flow_id", id).eq("organization_id", activeOrg.orgId),
  ]);
  if (!flow) redirect("/app/flows");

  const initialData = { ...flow, nodes: nodes ?? [], edges: edges ?? [] } as unknown as FlowDetailRow;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Link href="/app/flows" className="flex items-center gap-1 text-sm text-text-muted hover:text-text">
          <CaretLeft size={14} aria-hidden /> Fluxos
        </Link>
      </div>
      <FlowBuilder flowId={id} initialData={initialData} />
    </div>
  );
}
