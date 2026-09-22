"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  pedirEstadoDoCadastroIncorporado,
  useConcluirCadastroIncorporado,
  type CanalConectadoPeloCadastro,
} from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import {
  abrirCadastroDaMeta,
  carregarSdkDaMeta,
  configPublicaDoCadastro,
  lerMensagemDoCadastro,
  type MensagemDoCadastro,
  type RespostaDoLogin,
  type SdkDaMeta,
} from "@/lib/channels/meta/cadastro-incorporado-navegador";

type Fase =
  | "preparando"
  | "pronto"
  | "aguardando_meta"
  | "concluindo"
  | "sucesso"
  | "cancelado"
  | "erro"
  | "sdk_bloqueado";

interface Props {
  readonly disponivel: boolean;
  readonly faltando: readonly string[];
  readonly versaoDaGraph: string;
  /** Quem administra a instalação vê os nomes do que falta; os demais, a quem pedir. */
  readonly configurarNaInstalacao: boolean;
  readonly jaConectado: boolean;
}

/** Quanto esperar pela mensagem de sessão depois do code — o code vale só 30 s. */
const ESPERA_PELA_MENSAGEM_MS = 1500;
/** Renova o `state` um minuto antes de ele vencer. */
const FOLGA_DO_ESTADO_MS = 60_000;

/**
 * "Conectar WhatsApp com Meta": o Cadastro Incorporado (Embedded Signup v4).
 *
 * O navegador só abre o fluxo e devolve o authorization code ao servidor — o token
 * nunca passa por aqui. Duas regras de navegador moldam o componente:
 *
 * - o popup só abre se `FB.login` for chamado SÍNCRONO no clique. Por isso o SDK
 *   e o `state` são preparados ANTES, e o botão só habilita com os dois prontos;
 * - o code vale 30 s. Por isso ele não vai para estado do React nem espera nada
 *   além de um instante pela mensagem de sessão (que é só sugestão).
 */
export function BotaoCadastroIncorporado({
  disponivel,
  faltando,
  versaoDaGraph,
  configurarNaInstalacao,
  jaConectado,
}: Props) {
  const t = useT();
  const concluir = useConcluirCadastroIncorporado();

  const [fase, setFase] = useState<Fase>("preparando");
  const [mensagemDeErro, setMensagemDeErro] = useState<string | null>(null);
  const [conectado, setConectado] = useState<CanalConectadoPeloCadastro | null>(null);
  const [sdk, setSdk] = useState<SdkDaMeta | null>(null);
  /** Quando o `state` preparado vence. `null` = nenhum pronto para uso. */
  const [estadoExpiraEmMs, setEstadoExpiraEmMs] = useState<number | null>(null);
  const [preparando, setPreparando] = useState(false);

  // Refs só em handlers e efeitos: o `state` e o code não são dado de tela.
  const estadoRef = useRef<{ state: string; expiraEmMs: number } | null>(null);
  const mensagemRef = useRef<MensagemDoCadastro | null>(null);
  const emFluxoRef = useRef(false);

  const config = disponivel ? configPublicaDoCadastro() : null;
  /** Busca um `state` novo. Quem descarta o anterior (e desabilita o botão) é quem chama. */
  const prepararEstado = useCallback(
    () =>
      pedirEstadoDoCadastroIncorporado()
        .then((r) => {
          const expiraEmMs = Date.parse(r.data.expira_em);
          estadoRef.current = { state: r.data.state, expiraEmMs };
          setEstadoExpiraEmMs(expiraEmMs);
        })
        .catch((err: unknown) => {
          setMensagemDeErro(err instanceof ApiError ? err.message : null);
          setFase("erro");
        })
        .finally(() => setPreparando(false)),
    [],
  );

  useEffect(() => {
    if (!config) return;
    let vivo = true;
    carregarSdkDaMeta(config.appId, versaoDaGraph)
      .then((carregado) => {
        if (!vivo) return;
        setSdk(carregado);
        setFase((f) => (f === "preparando" ? "pronto" : f));
      })
      .catch(() => {
        if (vivo) setFase("sdk_bloqueado");
      });
    void prepararEstado();
    return () => {
      vivo = false;
    };
    // A config vem do <PublicEnvScript/> e não muda durante a página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.appId, config?.configId, versaoDaGraph, prepararEstado]);

  // Renova o `state` um minuto antes de vencer — mas nunca no meio de um fluxo aberto.
  useEffect(() => {
    if (estadoExpiraEmMs === null) return;
    const espera = Math.max(estadoExpiraEmMs - Date.now() - FOLGA_DO_ESTADO_MS, 5_000);
    const id = window.setTimeout(() => {
      if (emFluxoRef.current) return;
      estadoRef.current = null;
      setEstadoExpiraEmMs(null);
      void prepararEstado();
    }, espera);
    return () => window.clearTimeout(id);
  }, [estadoExpiraEmMs, prepararEstado]);

  useEffect(() => {
    function aoReceber(evento: MessageEvent) {
      if (!emFluxoRef.current) return;
      const mensagem = lerMensagemDoCadastro(evento.origin, evento.data);
      if (mensagem) mensagemRef.current = mensagem;
    }
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, []);

  function descartarEstadoEPreparar() {
    estadoRef.current = null;
    setEstadoExpiraEmMs(null);
    setPreparando(true);
    void prepararEstado();
  }

  function encerrarFluxo() {
    emFluxoRef.current = false;
    descartarEstadoEPreparar();
  }

  function aoVoltar(resposta: RespostaDoLogin) {
    const code = resposta?.authResponse?.code;
    const estado = estadoRef.current;
    if (!code || !estado) {
      const m = mensagemRef.current;
      if (m?.tipo === "erro") {
        setMensagemDeErro(t("A Meta interrompeu a conexão com um erro. Tente de novo; se persistir, confira a conta no Gerenciador de Negócios da Meta."));
        setFase("erro");
      } else {
        setFase("cancelado");
      }
      encerrarFluxo();
      return;
    }

    setFase("concluindo");
    estadoRef.current = null;
    const inicio = Date.now();
    const esperar = (): Promise<void> =>
      mensagemRef.current || Date.now() - inicio >= ESPERA_PELA_MENSAGEM_MS
        ? Promise.resolve()
        : new Promise((r) => window.setTimeout(r, 100)).then(esperar);

    void esperar()
      .then(() => {
        const m = mensagemRef.current;
        return concluir.mutateAsync({
          state: estado.state,
          code,
          evento: m?.tipo === "concluido" ? m.evento : undefined,
          sugestao:
            m?.tipo === "concluido" ? { waba_id: m.wabaId, phone_number_id: m.phoneNumberId } : undefined,
        });
      })
      .then((r) => {
        setConectado(r.data);
        setFase("sucesso");
        toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
      })
      .catch((err) => {
        setMensagemDeErro(
          err instanceof ApiError ? err.message : t("Não foi possível falar com o CRM. Confira a conexão e tente de novo."),
        );
        setFase("erro");
      })
      .finally(encerrarFluxo);
  }

  function aoClicar() {
    const estado = estadoRef.current;
    if (!sdk || !estado || !config || estado.expiraEmMs <= Date.now()) return;
    mensagemRef.current = null;
    emFluxoRef.current = true;
    setMensagemDeErro(null);
    setConectado(null);
    setFase("aguardando_meta");
    // Nada assíncrono antes desta linha — ver o cabeçalho.
    abrirCadastroDaMeta(sdk, config.configId, aoVoltar);
  }

  if (!disponivel || !config) {
    return (
      <Card className="p-4" data-testid="cadastro-meta-indisponivel">
        <h2 className="font-medium">{t("Conectar WhatsApp com Meta")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {configurarNaInstalacao
            ? t("Esta opção ainda não está configurada nesta instalação. Defina no arquivo de instalação as variáveis abaixo e cadastre a chave secreta em Admin › API Oficial (Meta):")
            : t("Esta opção ainda não está configurada nesta instalação. Peça a quem administra a instalação — enquanto isso, use a conexão manual abaixo.")}
        </p>
        {configurarNaInstalacao && faltando.length > 0 ? (
          <ul className="mt-2 list-inside list-disc font-mono text-xs">
            {faltando.map((nome) => (
              <li key={nome}>{nome}</li>
            ))}
          </ul>
        ) : null}
      </Card>
    );
  }

  const ocupado = fase === "aguardando_meta" || fase === "concluindo";
  const estadoPronto = estadoExpiraEmMs !== null;
  const pronto = Boolean(sdk) && estadoPronto && fase !== "sdk_bloqueado";
  // A preparação falhou (rede, limite de tentativas): o botão vira o caminho de volta,
  // em vez de ficar em "preparando" para sempre.
  const precisaPreparar = !estadoPronto && fase === "erro";

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="cadastro-meta">
      <div>
        <h2 className="font-medium">{t("Conectar WhatsApp com Meta")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Você entra na sua conta da Meta, escolhe a conta do WhatsApp Business e o número, e o CRM guarda a autorização sozinho — sem copiar ID nem token.")}
        </p>
      </div>

      <div>
        <Button
          type="button"
          onClick={precisaPreparar ? descartarEstadoEPreparar : aoClicar}
          disabled={precisaPreparar ? preparando : !pronto || ocupado}
          data-testid="btn-cadastro-meta"
        >
          {precisaPreparar
            ? t("Tentar de novo")
            : fase === "aguardando_meta"
            ? t("Aguardando a Meta…")
            : fase === "concluindo"
              ? t("Conectando…")
              : !pronto && fase !== "sdk_bloqueado"
                ? t("Preparando…")
                : jaConectado
                  ? t("Reconectar com a Meta")
                  : t("Conectar WhatsApp com Meta")}
        </Button>
      </div>

      <div aria-live="polite" data-testid="cadastro-meta-estado" data-fase={fase}>
        {fase === "sucesso" && conectado ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
            <p className="font-medium">
              {t("Conectado:")} {conectado.displayName} {conectado.phoneNumber ?? ""}
            </p>
            {conectado.webhookRegistro && !conectado.webhookRegistro.registrado ? (
              <p className="mt-1">{t("O canal envia, mas o recebimento ainda não foi ativado — veja o aviso de webhook abaixo.")}</p>
            ) : null}
            <p className="mt-1 text-muted-foreground">
              {t("Próximos passos na Meta: cadastre uma forma de pagamento no WhatsApp Manager. Se o número é novo, conclua o registro dele antes do primeiro envio.")}
            </p>
          </div>
        ) : null}
        {fase === "cancelado" ? (
          <p className="text-sm text-muted-foreground">
            {t("A conexão foi cancelada antes de terminar. Nada foi alterado.")}
          </p>
        ) : null}
        {fase === "sdk_bloqueado" ? (
          <p className="text-sm text-destructive">
            {t("Não foi possível carregar o login da Meta. Desative bloqueadores de anúncio ou de rastreamento para este site e recarregue a página.")}
          </p>
        ) : null}
        {fase === "erro" ? (
          <p className="text-sm text-destructive">
            {mensagemDeErro ?? t("Não foi possível conectar.")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
