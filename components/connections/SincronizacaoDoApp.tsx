"use client";
/**
 * Histórico e contatos do aplicativo WhatsApp Business — o cartão da página do
 * canal oficial num número em coexistência (Fase 2.0, migration 0420).
 *
 * A Meta só entrega o histórico e a agenda do aplicativo se o CRM PEDIR em até
 * 24h da conexão, e uma vez só. Conexões novas já pedem sozinhas; este botão é o
 * caminho de quem conectou antes disso, e o de tentar de novo o que falhou. O
 * cartão diz o que foi pedido, o que já chegou e até quando dá para pedir — e não
 * promete importação: nesta fase o que chega é guardado, não aparece nas conversas.
 *
 * Fora da coexistência (ou sem acesso ao estado), não renderiza nada.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSincronizacaoDoApp, useSolicitarSincronizacaoDoApp } from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import type { LinhaDaSincronizacao } from "@/lib/channels/meta/sincronizacao";

function rotuloDoEstado(linha: LinhaDaSincronizacao | null, t: (s: string) => string): string {
  if (!linha) return t("não pedido");
  if (linha.status === "solicitada") return linha.recebido_em ? t("pedido aceito — dados recebidos") : t("pedido aceito — aguardando a Meta");
  if (linha.status === "solicitando") return t("pedindo…");
  if (linha.status === "falhou") return t("falhou");
  if (linha.status === "expirada") return t("prazo vencido");
  if (linha.status === "recusada") return t("desligado no aplicativo");
  return t("não pedido");
}

export function SincronizacaoDoApp({ conectado }: { conectado: boolean }) {
  const t = useT();
  const { data } = useSincronizacaoDoApp(conectado);
  const solicitar = useSolicitarSincronizacaoDoApp();
  const situacao = data?.data;
  if (!situacao || !situacao.disponivel) return null;

  const { contatos, historico } = situacao;
  const pedidos = [contatos, historico];
  const tudoPedido = pedidos.every((l) => l?.status === "solicitada" || l?.status === "recusada");
  const podePedir = situacao.dentroDoPrazo && !tudoPedido && !solicitar.isPending;

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="sincronizacao-do-app">
      <div>
        <h2 className="font-medium">{t("Histórico e contatos do aplicativo")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("A Meta só envia o histórico de conversas e os contatos do aplicativo WhatsApp Business se o CRM pedir em até 24 horas da conexão, e uma vez só. Por enquanto, o que chega fica guardado e ainda não aparece nas conversas.")}
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        <li className="flex flex-wrap items-center gap-2" data-testid="sincronizacao-contatos">
          <span>{t("Contatos")}</span>
          <Badge variant="outline">{rotuloDoEstado(contatos, t)}</Badge>
          {contatos?.status === "falhou" && contatos.erro ? (
            <span className="text-xs text-destructive">{contatos.erro}</span>
          ) : null}
        </li>
        <li className="flex flex-wrap items-center gap-2" data-testid="sincronizacao-historico">
          <span>{t("Histórico de conversas")}</span>
          <Badge variant="outline">{rotuloDoEstado(historico, t)}</Badge>
          {historico?.status === "falhou" && historico.erro ? (
            <span className="text-xs text-destructive">{historico.erro}</span>
          ) : null}
        </li>
      </ul>

      <p className="text-xs text-muted-foreground" data-testid="sincronizacao-prazo">
        {situacao.dentroDoPrazo
          ? `${t("Prazo para pedir:")} ${new Date(situacao.prazo).toLocaleString()}`
          : t("O prazo de 24 horas para pedir já passou. Para sincronizar, é preciso desconectar o número no aplicativo e conectar de novo.")}
      </p>

      {situacao.dentroDoPrazo && !tudoPedido ? (
        <div>
          <Button
            type="button"
            onClick={() => solicitar.mutate()}
            disabled={!podePedir}
            data-testid="btn-solicitar-sincronizacao"
          >
            {solicitar.isPending ? t("Pedindo…") : t("Pedir histórico e contatos")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
