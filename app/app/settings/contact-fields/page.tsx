/**
 * Configurações → Campos do Usuário (migration 0312).
 *
 * ── Por que esta tela precisou existir ──────────────────────────────────────
 *
 * O contato tem `custom_fields jsonb` desde a migration 0211, e o VALOR sempre
 * pôde ser gravado — pela API, pelo N8N, pela ação `update_custom_field` da
 * automação. O que nunca existiu foi a DEFINIÇÃO: o comentário daquela
 * migration manda declarar os campos em `crm_pipelines.settings.fields[]`, que
 * é configuração de FUNIL. Quem não usa funil não tinha onde declarar, e o nó
 * ACTION do flow pedia a chave DIGITADA — um erro de digitação gravava um campo
 * fantasma que a mensagem seguinte renderizava vazio, sem erro nenhum.
 *
 * Agora a lista é uma entidade: tem id para a integração citar, tipo para a
 * tela saber o que oferecer, pasta para caber na cabeça de quem tem trinta
 * campos, e arquivamento em vez de exclusão.
 *
 * ── `manager`, e não `admin` ────────────────────────────────────────────────
 *
 * Mesma régua da tela de Tags, ao lado: declarar vocabulário é trabalho de quem
 * monta a operação. Nada aqui apaga conversa nem mexe em dinheiro.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { CampoDoContato } from "@/lib/schemas/contact-fields";
import { createClient } from "@/lib/supabase/server";

import { RegistroDeCampos } from "./_registro";

export const metadata = { title: "Campos do Usuário" };
export const dynamic = "force-dynamic";

export default async function CamposDoUsuarioPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  // Client da SESSÃO: quem recorta a organização é a RLS de `contact_fields`.
  // O `.eq` é defesa em profundidade, não a única barreira.
  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_fields")
    .select("id, key, label, description, type, options, folder, archived_at, position")
    .eq("organization_id", activeOrg.orgId)
    .order("folder", { ascending: true })
    .order("position", { ascending: true })
    .order("label", { ascending: true });

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Campos do Usuário")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Os campos personalizados que você guarda sobre cada contato. Depois de criados, eles podem ser preenchidos por uma ação de fluxo, lidos como variável dentro de uma mensagem, testados numa condição e usados para segmentar um disparo.",
          )}
        </p>
      </header>

      {error ? (
        // Falha de leitura NÃO vira lista vazia: "nenhum campo" convida a criar
        // tudo de novo, e criar uma chave que já existe devolve 409 — ou, pior,
        // cria uma segunda com grafia diferente.
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t("Não foi possível carregar os campos agora. Recarregue a página.")}
        </div>
      ) : (
        <RegistroDeCampos initialData={(data ?? []) as unknown as CampoDoContato[]} />
      )}
    </div>
  );
}
