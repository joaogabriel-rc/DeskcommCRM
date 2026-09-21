"use client";

/**
 * O painel dos campos do contato: criar, pesquisar, editar, agrupar em pastas,
 * arquivar e ver o identificador.
 *
 * ── A chave aparece, e é por isso que ela é destacada ───────────────────────
 *
 * O que o operador vai DIGITAR dentro de uma mensagem é
 * `{{contact.custom_fields.<chave>}}`. Esconder a chave atrás do nome bonito
 * faria a tela ensinar um vocabulário que a mensagem não aceita. Então a chave
 * é mostrada em fonte mono, com botão de copiar a variável inteira pronta.
 *
 * ── Arquivar em vez de excluir ──────────────────────────────────────────────
 *
 * Arquivado some dos seletores (do nó ACTION, do segmento, do dossiê) e o valor
 * continua gravado no contato. É o estado certo para "parei de usar isto" sem
 * perder o histórico — e é reversível com um clique, ao contrário de excluir.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n/IdiomaProvider";
import {
  useAtualizarCampo,
  useCamposDoContato,
  useCriarCampo,
  useExcluirCampo,
} from "@/hooks/catalogo/useCatalogo";
import { Archive, Copy, MagnifyingGlass, PencilSimple, Plus, Trash } from "@/lib/ui/icons";
import {
  sugerirChave,
  TIPOS_DE_CAMPO,
  TIPO_DE_CAMPO_LABEL,
  type CampoDoContato,
  type TipoDeCampo,
  type TipoDeCampoAceito,
} from "@/lib/schemas/contact-fields";

type Rascunho = {
  id?: string;
  key: string;
  /** `true` quando a chave ainda pode ser digitada — só na criação. */
  chaveEditavel: boolean;
  label: string;
  description: string;
  type: TipoDeCampo;
  folder: string;
};

const VAZIO: Rascunho = {
  key: "",
  chaveEditavel: true,
  label: "",
  description: "",
  type: "text",
  folder: "Campos do Usuário",
};

export function RegistroDeCampos({ initialData }: { initialData: CampoDoContato[] }) {
  const t = useT();
  const [verArquivados, setVerArquivados] = useState(false);
  const { data: campos = [] } = useCamposDoContato({
    incluirArquivados: verArquivados,
    initialData,
  });
  const criar = useCriarCampo();
  const atualizar = useAtualizarCampo();
  const excluir = useExcluirCampo();

  const [busca, setBusca] = useState("");
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  // O nome foi tocado à mão? Enquanto não, a chave acompanha o nome. Depois de
  // o usuário editar a chave, ela para de ser sugerida — senão a tela
  // sobrescreveria uma escolha deliberada a cada letra digitada no nome.
  const [chaveTocada, setChaveTocada] = useState(false);

  const ativos = campos.filter((c) => !c.archived_at);
  const arquivados = campos.filter((c) => c.archived_at);

  const pastas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const filtrados = termo
      ? ativos.filter(
          (c) => c.label.toLowerCase().includes(termo) || c.key.toLowerCase().includes(termo),
        )
      : ativos;
    const mapa = new Map<string, CampoDoContato[]>();
    for (const campo of filtrados) {
      const lista = mapa.get(campo.folder) ?? [];
      lista.push(campo);
      mapa.set(campo.folder, lista);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b, "pt-BR"));
  }, [ativos, busca]);

  async function salvar() {
    if (!rascunho) return;
    const label = rascunho.label.trim();
    if (!label) return;
    if (rascunho.id) {
      await atualizar.mutateAsync({
        id: rascunho.id,
        label,
        description: rascunho.description.trim() || null,
        type: rascunho.type,
        folder: rascunho.folder.trim() || "Campos do Usuário",
      });
    } else {
      const key = (rascunho.key.trim() || sugerirChave(label)).toLowerCase();
      if (!key) {
        toast.error(t("Não consegui montar uma chave a partir desse nome. Digite a chave à mão."));
        return;
      }
      await criar.mutateAsync({
        key,
        label,
        description: rascunho.description.trim() || null,
        type: rascunho.type,
        folder: rascunho.folder.trim() || "Campos do Usuário",
        options: [],
      });
    }
    setRascunho(null);
  }

  async function copiarVariavel(key: string) {
    // Pelo helper do repo: numa VPS servida por http://IP a API do navegador
    // nem existe, e o `catch` nunca rodaria porque não haveria promessa.
    const copiou = await copyToClipboard(`{{contact.custom_fields.${key}}}`);
    if (copiou) toast.success(t("Variável copiada. Cole dentro do texto da mensagem."));
    // A variável vai no texto do erro: sem a área de transferência, o operador
    // ainda precisa saber o que digitar.
    else toast.error(`${t("Não foi possível copiar. A variável é")} {{contact.custom_fields.${key}}}`);
  }

  const ocupado = criar.isPending || atualizar.isPending;

  function abrirNovo() {
    setChaveTocada(false);
    setRascunho({ ...VAZIO });
  }

  function abrirEdicao(campo: CampoDoContato) {
    setChaveTocada(true);
    setRascunho({
      id: campo.id,
      key: campo.key,
      chaveEditavel: false,
      label: campo.label,
      description: campo.description ?? "",
      // O banco aceita tipos legados (`select`, `email`…) que o formulário não
      // oferece. Editar um desses sem cair no `text` exigiria um seletor com o
      // legado dentro, e oferecer "escolha única" sem editor de opções seria
      // controle decorativo — então o tipo legado é preservado como está e só
      // muda se o operador escolher um dos seis explicitamente.
      type: (TIPOS_DE_CAMPO as readonly string[]).includes(campo.type)
        ? (campo.type as TipoDeCampo)
        : "text",
      folder: campo.folder,
    });
  }

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
            placeholder={t("Pesquisar por nome ou chave do campo")}
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label={t("Pesquisar campo")}
          />
        </div>
        <Button variant="outline" onClick={() => setVerArquivados((v) => !v)}>
          <Archive size={16} aria-hidden className="mr-1" />
          {verArquivados ? t("Ocultar arquivados") : t("Ver arquivados")}
        </Button>
        <Button onClick={abrirNovo}>
          <Plus size={16} aria-hidden className="mr-1" /> {t("Novo campo")}
        </Button>
      </div>

      {pastas.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {busca.trim()
            ? t("Nenhum campo com esse nome.")
            : t(
                "Nenhum campo criado ainda. Crie o primeiro para poder preenchê-lo numa ação de fluxo e usá-lo como variável dentro da mensagem.",
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
              {lista.map((campo) => (
                <LinhaDeCampo
                  key={campo.id}
                  campo={campo}
                  onEditar={() => abrirEdicao(campo)}
                  onCopiar={() => copiarVariavel(campo.key)}
                  onArquivar={() => atualizar.mutate({ id: campo.id, archived: true })}
                  onExcluir={() => excluir.mutate(campo.id)}
                />
              ))}
            </ul>
          </Card>
        ))
      )}

      {verArquivados && (
        <Card className="overflow-hidden">
          <div className="border-b border-border/60 bg-muted/50 px-3 py-2">
            <span className="text-sm font-medium">{t("Campos arquivados")}</span>
            <p className="text-xs text-muted-foreground">
              {t("Somem dos seletores; o valor gravado em cada contato continua lá.")}
            </p>
          </div>
          {arquivados.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("Nenhum campo arquivado.")}</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {arquivados.map((campo) => (
                <li key={campo.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="min-w-40 flex-1 text-sm">{campo.label}</span>
                  <code className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{campo.key}</code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => atualizar.mutate({ id: campo.id, archived: false })}
                  >
                    {t("Desarquivar")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Dialog open={!!rascunho} onOpenChange={(aberto) => !aberto && setRascunho(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {rascunho?.id ? t("Editar campo do usuário") : t("Criar novo campo do usuário")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Os campos personalizados guardam informações sobre seus contatos — produto de interesse, origem, matrícula, o que a sua operação pedir. Depois você segmenta e personaliza mensagens com base neles.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campo-nome">{t("Nome")}</Label>
              <Input
                id="campo-nome"
                value={rascunho?.label ?? ""}
                maxLength={80}
                onChange={(e) => {
                  const label = e.target.value;
                  setRascunho((r) =>
                    r
                      ? {
                          ...r,
                          label,
                          key: r.chaveEditavel && !chaveTocada ? sugerirChave(label) : r.key,
                        }
                      : r,
                  );
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campo-chave">{t("Chave")}</Label>
              <Input
                id="campo-chave"
                className="font-mono"
                value={rascunho?.key ?? ""}
                maxLength={40}
                disabled={!rascunho?.chaveEditavel}
                onChange={(e) => {
                  setChaveTocada(true);
                  setRascunho((r) => (r ? { ...r, key: e.target.value.toLowerCase() } : r));
                }}
              />
              <p className="text-xs text-muted-foreground">
                {rascunho?.chaveEditavel
                  ? t(
                      "É como o campo é citado dentro das mensagens e pela API. Não muda depois de criado — por isso renomear o campo nunca quebra uma mensagem publicada.",
                    )
                  : t(
                      "A chave não muda depois de criada: ela está escrita dentro das mensagens que a citam. Renomeie o campo à vontade.",
                    )}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              {/* `htmlFor` + `id` no gatilho: sem os dois o rótulo não fica
                  associado ao controle, e quem usa leitor de tela ouve "botão"
                  sem saber de quê. */}
              <Label htmlFor="campo-tipo">{t("Tipo")}</Label>
              <Select
                value={rascunho?.type ?? "text"}
                onValueChange={(v) => setRascunho((r) => (r ? { ...r, type: v as TipoDeCampo } : r))}
              >
                <SelectTrigger id="campo-tipo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS_DE_CAMPO.map((tipo) => (
                    <SelectItem key={tipo} value={tipo}>
                      {t(TIPO_DE_CAMPO_LABEL[tipo])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campo-descricao">{t("Descrição (opcional)")}</Label>
              <Textarea
                id="campo-descricao"
                rows={2}
                value={rascunho?.description ?? ""}
                onChange={(e) => setRascunho((r) => (r ? { ...r, description: e.target.value } : r))}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campo-pasta">{t("Pasta")}</Label>
              <Input
                id="campo-pasta"
                value={rascunho?.folder ?? ""}
                maxLength={60}
                list="pastas-de-campo"
                onChange={(e) => setRascunho((r) => (r ? { ...r, folder: e.target.value } : r))}
              />
              <datalist id="pastas-de-campo">
                {[...new Set(campos.map((c) => c.folder))].map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>

            {rascunho?.id && (
              <p className="font-mono text-xs text-muted-foreground">ID: {rascunho.id}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRascunho(null)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={salvar} disabled={ocupado || !rascunho?.label.trim()}>
              {rascunho?.id ? t("Salvar") : t("Criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LinhaDeCampo({
  campo,
  onEditar,
  onCopiar,
  onArquivar,
  onExcluir,
}: {
  campo: CampoDoContato;
  onEditar: () => void;
  onCopiar: () => void;
  onArquivar: () => void;
  onExcluir: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-medium">{campo.label}</p>
        {campo.description && <p className="text-xs text-muted-foreground">{campo.description}</p>}
      </div>
      <span className="text-xs text-muted-foreground">
        {t(TIPO_DE_CAMPO_LABEL[campo.type as TipoDeCampoAceito] ?? campo.type)}
      </span>
      <button
        type="button"
        onClick={onCopiar}
        title={t("Copiar a variável pronta para colar na mensagem")}
        className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
      >
        {campo.key}
        <Copy size={12} aria-hidden />
      </button>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" aria-label={`${t("Editar")} ${campo.label}`} onClick={onEditar}>
          <PencilSimple size={16} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`${t("Arquivar")} ${campo.label}`}
          onClick={onArquivar}
        >
          <Archive size={16} aria-hidden />
        </Button>
        <Button size="icon" variant="ghost" aria-label={`${t("Excluir")} ${campo.label}`} onClick={onExcluir}>
          <Trash size={16} aria-hidden />
        </Button>
      </div>
    </li>
  );
}
