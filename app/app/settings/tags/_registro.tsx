"use client";

/**
 * O REGISTRO de etiquetas — criar, pesquisar, editar, organizar em pastas e ver
 * o identificador (migration 0312).
 *
 * ── Por que este painel é SEPARADO do que já estava na tela ─────────────────
 *
 * Eles respondem perguntas diferentes, e juntar os dois numa tabela só daria uma
 * tabela que não responde bem nenhuma das duas.
 *
 *   PainelDeTags (o de baixo)  "onde esta etiqueta está e o que quebra se eu
 *                               mexer" — uso por tabela, regras de agente,
 *                               renomear/juntar/excluir. É derivado do que já
 *                               foi escrito, e por isso lista também o que
 *                               nunca passou por cadastro nenhum.
 *   este                        "o que esta organização DECLAROU que existe" —
 *                               com id, pasta, cor e descrição, e com o botão
 *                               de criar ANTES do primeiro uso, que é o que
 *                               faltava para montar um flow com gatilho de tag
 *                               sem primeiro marcar um contato à mão.
 *
 * ── Por que o ID aparece ────────────────────────────────────────────────────
 *
 * Porque ele é a única coisa aqui que sobrevive a uma renomeação. Quem liga o
 * CRM ao N8N precisa de um identificador que não mude quando o marketing decidir
 * que "VIP" agora é "Cliente Ouro" — e sem ele na tela, a integração acaba
 * escrita contra a grafia.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n/IdiomaProvider";
import {
  useAtualizarTag,
  useCriarTag,
  useExcluirTag,
  useTags,
} from "@/hooks/catalogo/useCatalogo";
import { Copy, MagnifyingGlass, PencilSimple, Plus, Trash } from "@/lib/ui/icons";
import { PASTA_PADRAO, type TagDoRegistro } from "@/lib/schemas/tags";

interface Props {
  initialData: TagDoRegistro[];
  canWrite: boolean;
}

type Rascunho = {
  id?: string;
  name: string;
  folder: string;
  color: string;
  description: string;
};

const VAZIO: Rascunho = { name: "", folder: PASTA_PADRAO, color: "", description: "" };

export function RegistroDeTags({ initialData, canWrite }: Props) {
  const t = useT();
  const { data: tags = [] } = useTags({ initialData });
  const criar = useCriarTag();
  const atualizar = useAtualizarTag();
  const excluir = useExcluirTag();

  const [busca, setBusca] = useState("");
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);

  const pastas = useMemo(() => {
    const filtradas = busca.trim()
      ? tags.filter((t) => t.name.toLowerCase().includes(busca.trim().toLowerCase()))
      : tags;
    const mapa = new Map<string, TagDoRegistro[]>();
    for (const tag of filtradas) {
      const lista = mapa.get(tag.folder) ?? [];
      lista.push(tag);
      mapa.set(tag.folder, lista);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b, "pt-BR"));
  }, [tags, busca]);

  async function salvar() {
    if (!rascunho) return;
    const payload = {
      name: rascunho.name.trim(),
      folder: rascunho.folder.trim() || PASTA_PADRAO,
      color: rascunho.color.trim() || null,
      description: rascunho.description.trim() || null,
    };
    if (!payload.name) return;
    if (rascunho.id) await atualizar.mutateAsync({ id: rascunho.id, ...payload });
    else await criar.mutateAsync(payload);
    setRascunho(null);
  }

  async function copiarId(id: string) {
    // `copyToClipboard`, e NUNCA a API do navegador direto: numa VPS servida
    // por http://IP não existe `isSecureContext`, e a API nem está definida. O
    // helper do repo cai no textarea + execCommand nesse caso.
    const copiou = await copyToClipboard(id);
    if (copiou) toast.success(t("Identificador copiado."));
    // O id continua visível na tela — dizer isso é melhor que um erro mudo.
    else toast.error(t("Não foi possível copiar. Selecione o identificador na tela."));
  }

  const ocupado = criar.isPending || atualizar.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <MagnifyingGlass
            size={16}
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-8"
            placeholder={t("Pesquisar por nome da tag")}
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label={t("Pesquisar por nome da tag")}
          />
        </div>
        {canWrite && (
          <Button onClick={() => setRascunho({ ...VAZIO })}>
            <Plus size={16} aria-hidden className="mr-1" /> {t("Nova tag")}
          </Button>
        )}
      </div>

      {pastas.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {busca.trim()
            ? t("Nenhuma tag com esse nome.")
            : t(
                "Nenhuma tag declarada ainda. Crie a primeira para poder usá-la como gatilho de fluxo, em ações e na segmentação de disparos.",
              )}
        </Card>
      ) : (
        pastas.map(([pasta, lista]) => (
          <Card key={pasta} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/50 px-3 py-2">
              <span className="text-sm font-medium">{pasta}</span>
              <span className="text-xs text-muted-foreground">{lista.length}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {lista.map((tag) => (
                <li key={tag.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full border border-border"
                    style={tag.color ? { backgroundColor: tag.color } : undefined}
                  />
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{tag.name}</p>
                    {tag.description && (
                      <p className="text-xs text-muted-foreground">{tag.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => copiarId(tag.id)}
                    title={t("Copiar identificador (é ele que a API e o N8N usam)")}
                    className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    {tag.id.slice(0, 8)}
                    <Copy size={12} aria-hidden />
                  </button>
                  {canWrite && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${t("Editar")} ${tag.name}`}
                        onClick={() =>
                          setRascunho({
                            id: tag.id,
                            name: tag.name,
                            folder: tag.folder,
                            color: tag.color ?? "",
                            description: tag.description ?? "",
                          })
                        }
                      >
                        <PencilSimple size={16} aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${t("Remover do vocabulário")}: ${tag.name}`}
                        onClick={() => excluir.mutate(tag.id)}
                      >
                        <Trash size={16} aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      <Dialog open={!!rascunho} onOpenChange={(aberto) => !aberto && setRascunho(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rascunho?.id ? t("Editar tag") : t("Criar tag")}</DialogTitle>
            <DialogDescription>
              {rascunho?.id
                ? t(
                    "Renomear aqui corrige também os contatos, os negócios, as conversas e as regras de agente que já usam este nome — na mesma operação. O identificador não muda.",
                  )
                : t(
                    "A tag descreve uma característica do contato. Depois de criada, ela pode iniciar um fluxo, ser aplicada por uma ação e filtrar o público de um disparo.",
                  )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tag-nome">{t("Nome")}</Label>
              <Input
                id="tag-nome"
                value={rascunho?.name ?? ""}
                maxLength={60}
                placeholder={t("Inserir nome da tag")}
                onChange={(e) => setRascunho((r) => (r ? { ...r, name: e.target.value } : r))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tag-pasta">{t("Pasta")}</Label>
              <Input
                id="tag-pasta"
                value={rascunho?.folder ?? ""}
                maxLength={60}
                list="pastas-de-tag"
                onChange={(e) => setRascunho((r) => (r ? { ...r, folder: e.target.value } : r))}
              />
              {/* A pasta é texto livre no banco, então a lista é DERIVADA do que
                  já existe — não há um segundo cadastro de pastas para manter. */}
              <datalist id="pastas-de-tag">
                {[...new Set(tags.map((t) => t.folder))].map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tag-cor">{t("Cor (opcional)")}</Label>
              <Input
                id="tag-cor"
                value={rascunho?.color ?? ""}
                placeholder="#22c55e"
                onChange={(e) => setRascunho((r) => (r ? { ...r, color: e.target.value } : r))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tag-descricao">{t("Descrição (opcional)")}</Label>
              <Textarea
                id="tag-descricao"
                rows={2}
                value={rascunho?.description ?? ""}
                onChange={(e) => setRascunho((r) => (r ? { ...r, description: e.target.value } : r))}
              />
            </div>
            {rascunho?.id && (
              <p className="font-mono text-xs text-muted-foreground">ID: {rascunho.id}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRascunho(null)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={salvar} disabled={ocupado || !rascunho?.name.trim()}>
              {rascunho?.id ? t("Salvar") : t("Criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
