/**
 * A IMAGEM de um bloco do nó de mensagem (0502).
 *
 *   POST /api/v1/flows/[id]/media   sobe a imagem (multipart, campo `file`)
 *   GET  /api/v1/flows/[id]/media?path=…   link assinado curto, para a prévia
 *
 * O arquivo mora em `whatsapp-media/<org>/flows/<fluxo>/…` — a pasta do FLUXO,
 * fora das duas que a retenção de mídia varre como órfãs (`<org>/<conversa>/` e
 * `<org>/avatars/`). No envio, o motor COPIA a imagem para a pasta da conversa
 * (`lib/flows/nodes/message.ts`): a cópia é o que a inbox mostra e o que a
 * retenção e a LGPD alcançam; o arquivo do fluxo segue intacto para o próximo
 * contato.
 *
 * Mesmo papel do construtor (`manager`), e a organização vem da sessão — o
 * caminho é montado aqui, nunca recebido do corpo. O GET confere que o caminho
 * pedido é DESTE fluxo e DESTA organização antes de assinar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { extFromMime } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const BUCKET = "whatsapp-media";
/** O teto da Meta para imagem em mensagem; o WAHA aceita o mesmo. */
const MAX_IMAGEM_BYTES = 5 * 1024 * 1024;
const TIPOS = new Set(["image/jpeg", "image/png"]);
const LINK_VALIDO_POR_S = 60 * 60;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

async function fluxoDaOrganizacao(orgId: string, flowId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return !!data;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: flowId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  if (!(await fluxoDaOrganizacao(orgId, flowId))) {
    return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });
  }

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > MAX_IMAGEM_BYTES + 1_048_576) {
    return fail("payload_too_large", t("Imagem acima de 5MB."), 413, { requestId });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  const mime = file.type || "application/octet-stream";
  if (!TIPOS.has(mime)) {
    return fail("unsupported_media_type", t("Use uma imagem JPG ou PNG."), 415, { requestId });
  }
  if (!file.size || file.size > MAX_IMAGEM_BYTES) {
    return fail("payload_too_large", t("Imagem acima de 5MB."), 413, { requestId });
  }

  const caminho = `${orgId}/flows/${flowId}/${randomUUID()}.${extFromMime(mime)}`;
  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(caminho, Buffer.from(await file.arrayBuffer()), { contentType: mime, upsert: false });
  if (error) {
    logger.error("[flows.media] upload falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", t("Não consegui subir a imagem."), 500, { requestId });
  }
  const { data: assinado } = await admin.storage.from(BUCKET).createSignedUrl(caminho, LINK_VALIDO_POR_S);

  void audit({
    action: "flows.media_uploaded",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "flow",
    resourceId: flowId,
    requestId,
    metadata: { media_mime: mime, size_bytes: file.size },
  });

  return ok(
    { storage_path: caminho, media_mime: mime, url: assinado?.signedUrl ?? null },
    { requestId, status: 201 },
  );
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: flowId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const caminho = req.nextUrl.searchParams.get("path") ?? "";
  // Só um arquivo DESTE fluxo, desta organização, sem subir de pasta.
  if (!caminho.startsWith(`${orgId}/flows/${flowId}/`) || caminho.includes("..")) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }
  if (!(await fluxoDaOrganizacao(orgId, flowId))) {
    return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });
  }
  const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUrl(caminho, LINK_VALIDO_POR_S);
  if (error || !data?.signedUrl) return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  return ok({ url: data.signedUrl }, { requestId });
}
