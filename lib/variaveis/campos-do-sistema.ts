/**
 * Os CAMPOS DO SISTEMA que uma mensagem pode citar — uma lista só, para o
 * autocomplete do editor de modelos, o "Inserir variável" dos fluxos e o
 * preenchimento padrão dos valores de um modelo escolhido no fluxo.
 *
 * `chave` é o nome da variável quando ela entra num modelo da Meta (formato
 * NAMED: letras minúsculas, números e `_`). `caminho` é o que o resolvedor dos
 * fluxos entende (`renderFlowTemplate`): é por ele que o valor REAL de cada
 * contato entra no envio.
 *
 * `first_name` e `last_name` não são colunas: o contato tem um `name` só.
 * O resolvedor os CALCULA do nome (primeira palavra / o resto) — ver
 * `lib/flows/template.ts`. Sem coluna nova, sem sincronização.
 *
 * Os "Campos do usuário" (registro da organização, `contact_fields`) entram ao
 * lado, pela chave de cada um — que já nasce no formato que a Meta aceita
 * (`^[a-z][a-z0-9_]{0,39}$`, migration 0389).
 */
export interface CampoDoSistema {
  chave: string;
  rotulo: string;
  caminho: string;
  /** Nome do ícone da tela; o componente escolhe o desenho. */
  icone: "texto" | "email" | "telefone";
}

export const CAMPOS_DO_SISTEMA: readonly CampoDoSistema[] = [
  { chave: "primeiro_nome", rotulo: "Primeiro nome", caminho: "contact.first_name", icone: "texto" },
  { chave: "sobrenome", rotulo: "Sobrenome", caminho: "contact.last_name", icone: "texto" },
  { chave: "nome_completo", rotulo: "Nome completo", caminho: "contact.name", icone: "texto" },
  { chave: "nome_de_exibicao", rotulo: "Nome de exibição", caminho: "contact.display_name", icone: "texto" },
  { chave: "email", rotulo: "E-mail", caminho: "contact.email", icone: "email" },
  { chave: "celular", rotulo: "Celular", caminho: "contact.phone", icone: "telefone" },
];

/** O caminho de um campo do usuário (registro da organização). */
export function caminhoDoCampoDoUsuario(chave: string): string {
  return `contact.custom_fields.${chave}`;
}

/**
 * O valor padrão de uma variável de modelo no fluxo/disparo, pelo NOME dela.
 *
 * Uma variável criada pelo autocomplete tem o nome do campo (`{{primeiro_nome}}`),
 * então o fluxo já sabe o que pôr ali. Nome livre (`{{var1}}`) não tem padrão:
 * quem monta o fluxo escolhe. É derivação, não registro — nada a gravar.
 */
export function valorPadraoDaVariavel(nome: string, camposDoUsuario: ReadonlyArray<{ key: string }>): string | null {
  const sistema = CAMPOS_DO_SISTEMA.find((c) => c.chave === nome);
  if (sistema) return `{{${sistema.caminho}}}`;
  if (camposDoUsuario.some((c) => c.key === nome)) return `{{${caminhoDoCampoDoUsuario(nome)}}}`;
  return null;
}
