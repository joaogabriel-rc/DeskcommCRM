/**
 * POST /api/v1/broadcasts/[id]/duplicar — um disparo NOVO, em rascunho, com a
 * mesma mensagem, o mesmo público e uma CÓPIA independente do fluxo.
 *
 * É a saída do fluxo protegido (migration 0507): a definição que um disparo
 * usou vira histórico e não se edita — quem quer mudar o caminho duplica e
 * edita a cópia, que nasce editável.
 *
 * A cópia da ESTRUTURA é do banco (`fn_broadcast_duplicar`, `security invoker`:
 * vale a RLS de quem chama, numa transação só) — nós, configurações, posições
 * e arestas com ids novos, e nada de execução, evento, destinatário ou mensagem.
 * A cópia dos ARQUIVOS é daqui, porque o Storage não está no banco: a imagem de
 * um bloco mora em `<org>/flows/<fluxo>/…`, a função já reescreveu o caminho
 * para a pasta do fluxo novo, e esta rota copia cada arquivo para lá. Sem a
 * cópia, a prévia do editor (que só assina arquivo da pasta do PRÓPRIO fluxo)
 * mostraria a imagem quebrada. Se uma cópia falha, o disparo novo é apagado —
 * ele é rascunho sem nada, e a guarda do banco deixa — e a resposta é erro, em
 * vez de um clone pela metade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { caminhosDeImagem } from "@/lib/disparos/duplicar";
import { arquivoDoCaminho, caminhoDeMidiaDoFluxo } from "@/lib/flows/caminho-de-midia";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const BUCKET = "whatsapp-media";

interface ResultadoDaDuplicacao {
  broadcast_id: string;
  flow_id: string | null;
  flow_id_origem: string | null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "broadcasts" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await params;
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("fn_broadcast_duplicar", {
    p_broadcast: id,
    p_organization_id: orgId,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Disparo não encontrado.", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }
  const r = data as ResultadoDaDuplicacao;

  // Os arquivos de imagem: a config do fluxo novo já aponta para a pasta dele;
  // o arquivo de origem tem o mesmo nome na pasta do fluxo antigo.
  let copiados = 0;
  if (r.flow_id && r.flow_id_origem) {
    const { data: nos } = await supabase
      .from("flow_nodes")
      .select("config")
      .eq("organization_id", orgId)
      .eq("flow_id", r.flow_id);
    const destinos = [
      ...new Set((nos ?? []).flatMap((n) => caminhosDeImagem((n as { config: unknown }).config))),
    ];
    // Todo caminho tem de estar no contrato `<org>/flows/<fluxo>/<arquivo>` —
    // o destino na pasta do fluxo NOVO e a origem na do fluxo de ORIGEM — antes
    // de o client admin tocar no Storage. Fora dele (um `..`, outra pasta, outra
    // organização), nada é lido nem copiado, e o disparo novo é desfeito.
    const fora = destinos.find(
      (d) =>
        !caminhoDeMidiaDoFluxo(d, orgId, r.flow_id!) ||
        !caminhoDeMidiaDoFluxo(`${orgId}/flows/${r.flow_id_origem}/${arquivoDoCaminho(d)}`, orgId, r.flow_id_origem!),
    );
    if (fora !== undefined) {
      logger.warn("[broadcasts.duplicar] imagem fora do fluxo", { request_id: requestId });
      await supabase.from("broadcasts").delete().eq("id", r.broadcast_id).eq("organization_id", orgId);
      return fail(
        "validation_failed",
        "Uma imagem deste fluxo não está na pasta dele. Nada foi criado — envie a imagem de novo no fluxo de origem.",
        422,
        { requestId },
      );
    }

    const admin = createAdminClient();
    for (const destino of destinos) {
      const origem = `${orgId}/flows/${r.flow_id_origem}/${arquivoDoCaminho(destino)}`;
      const { error: copiaErr } = await admin.storage.from(BUCKET).copy(origem, destino);
      if (copiaErr) {
        logger.error("[broadcasts.duplicar] cópia de imagem falhou", {
          request_id: requestId,
          error: copiaErr.message,
        });
        await supabase.from("broadcasts").delete().eq("id", r.broadcast_id).eq("organization_id", orgId);
        return fail(
          "internal_error",
          "Não consegui copiar uma imagem do fluxo. Nada foi criado — tente de novo.",
          500,
          { requestId },
        );
      }
      copiados += 1;
    }
  }

  void audit({
    action: "broadcast.duplicated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "broadcast",
    resourceId: r.broadcast_id,
    requestId,
    metadata: { origem: id, fluxo: r.flow_id, fluxo_origem: r.flow_id_origem, imagens_copiadas: copiados },
  });

  return ok(r, { requestId, status: 201 });
}
