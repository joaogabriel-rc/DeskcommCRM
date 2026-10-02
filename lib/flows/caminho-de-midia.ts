/**
 * O CAMINHO DA IMAGEM DE UM FLUXO — validado pela ESTRUTURA, antes de ser usado.
 *
 * A imagem de um bloco de mensagem mora em `whatsapp-media/<org>/flows/<fluxo>/<arquivo>`
 * (`app/api/v1/flows/[id]/media/route.ts` monta o caminho assim, com o arquivo
 * `<uuid>.<ext>`). O caminho fica gravado em `flow_nodes.config`, que o gestor
 * escreve como quiser (rota de grafo ou REST direta) — então ele é ENTRADA, e o
 * motor de envio e a duplicação o usam com o client ADMIN do Storage, que não
 * conhece organização. Um `..` ali, num backend que resolva caminho, leria o
 * arquivo de outra organização.
 *
 * A regra não normaliza nada (normalizar é decidir o que o caminho QUERIA dizer;
 * aqui só passa o que já está no formato): exatamente quatro segmentos —
 * a organização esperada, `flows`, o fluxo esperado e um nome de arquivo de
 * caracteres seguros com uma extensão. Organização e fluxo são comparados por
 * IGUALDADE com os valores confiáveis de quem chama (sessão, execução, banco),
 * nunca extraídos do próprio caminho. `%`, `\`, espaço, ponto inicial e `..`
 * não cabem no nome do arquivo — o que também fecha traversal codificado
 * (`%2e%2e`), que um Storage poderia decodificar depois.
 */

/** `<nome>.<ext>`: começa por letra ou número, sem ponto no meio do nome. */
const NOME_DO_ARQUIVO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9]{1,8}$/;

export function caminhoDeMidiaDoFluxo(caminho: unknown, organizationId: string, flowId: string): boolean {
  if (typeof caminho !== "string" || !organizationId || !flowId) return false;
  const partes = caminho.split("/");
  if (partes.length !== 4) return false;
  const [org, pasta, fluxo, arquivo] = partes as [string, string, string, string];
  return org === organizationId && pasta === "flows" && fluxo === flowId && NOME_DO_ARQUIVO.test(arquivo);
}

/** O nome do arquivo de um caminho JÁ validado por `caminhoDeMidiaDoFluxo`. */
export function arquivoDoCaminho(caminho: string): string {
  return caminho.slice(caminho.lastIndexOf("/") + 1);
}
