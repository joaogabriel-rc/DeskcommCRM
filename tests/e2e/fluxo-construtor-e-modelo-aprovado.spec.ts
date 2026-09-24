/**
 * FLUXO NASCE NO CONSTRUTOR, E O MODELO APROVADO É ESCOLHIDO DE UMA LISTA — pela tela.
 *
 * A jornada que a Rodada 1 mudou, dirigida como um operador faria:
 *
 *   A. "Novo flow" não pergunta nada: abre o construtor com "Sem título" e o
 *      "Quando…" selecionado; salva sem gatilho; Ativar recusa dizendo onde
 *      escolher; escolhido o gatilho (tag), liga.
 *   B. No passo de mensagem fora da janela, "Escolher modelo de mensagem" lista
 *      SÓ os aprovados do número escolhido, busca funciona, e o modelo aparece
 *      no painel e no card com cabeçalho, corpo, rodapé e botões — os espaços
 *      vêm do contrato, sem chave digitada.
 *   C. Cada resposta rápida vira uma saída do nó, e uma saída ligada a outro
 *      passo é gravada com o `source_handle` do botão.
 *   D. Fluxo ANTIGO (nome e idioma digitados): com correspondência, oferece
 *      "Vincular a este modelo"; sem, avisa "Modelo não localizado".
 *
 * O cenário (dois números oficiais de contas diferentes, modelos aprovado,
 * pausado e de outra conta, dois fluxos antigos) é semeado AQUI, por service
 * role, com sufixo único — e removido no fim. Sem Meta de verdade: o catálogo
 * é o espelho `meta_templates`, que é o que a tela lê.
 *
 * Evidência: `evidence/fluxos-rodada1/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { hashContract } from "../../lib/channels/meta/contract-hash";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "fluxos-rodada1");
const ts = Date.now();

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;

const WABA_A = `9${String(ts).slice(-12)}1`;
const WABA_B = `9${String(ts).slice(-12)}2`;
const MODELO = `e2e_pedido_${ts}`;
const PAUSADO = `e2e_pausado_${ts}`;
const OUTRA_CONTA = `e2e_outra_conta_${ts}`;
const TAG = `E2E-R1-${ts}`;

const COMPONENTES = [
  { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
  { type: "BODY", text: "Olá {{1}}, seu pedido {{2}} saiu para entrega." },
  { type: "FOOTER", text: "Loja E2E" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirmar" },
      { type: "QUICK_REPLY", text: "Parar mensagens" },
      { type: "URL", text: "Rastrear", url: "https://loja.test/r/{{1}}" },
    ],
  },
];
const SIMPLES = [{ type: "BODY", text: "Mensagem simples" }];

let admin: SupabaseClient;
const criados = { sessoes: [] as string[], modelos: [] as string[], fluxos: [] as string[] };
let sessaoA = "";
let fluxoAntigoComCorrespondencia = "";
let fluxoAntigoSemCorrespondencia = "";

function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: false });
}

async function login(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function sessao(nome: string, waba: string): Promise<string> {
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: ORG,
      provider: "meta_cloud",
      display_name: nome,
      meta_phone_number_id: `pn-${waba}`,
      meta_waba_id: waba,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed da sessão: ${error.message}`);
  criados.sessoes.push(data.id as string);
  return data.id as string;
}

async function modelo(nome: string, waba: string, status: string, components: unknown[]): Promise<string> {
  const { data, error } = await admin
    .from("meta_templates")
    .insert({
      organization_id: ORG,
      waba_id: waba,
      name: nome,
      language: "pt_BR",
      status,
      category: "UTILITY",
      components,
      contract_hash: hashContract(components, "POSITIONAL"),
      parameter_format: "POSITIONAL",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed do modelo: ${error.message}`);
  criados.modelos.push(data.id as string);
  return data.id as string;
}

/** Fluxo "antigo": o nó de mensagem só com nome e idioma digitados, como antes do seletor. */
async function fluxoAntigo(nome: string, templateName: string): Promise<string> {
  const { data: f, error } = await admin
    .from("flows")
    .insert({ organization_id: ORG, name: nome, trigger_type: "contact_tag_added", trigger_config: { tag: TAG } })
    .select("id")
    .single();
  if (error) throw new Error(`seed do fluxo: ${error.message}`);
  const id = f.id as string;
  criados.fluxos.push(id);
  const gatilho = crypto.randomUUID();
  const msg = crypto.randomUUID();
  await admin.from("flow_nodes").insert([
    { id: gatilho, organization_id: ORG, flow_id: id, type: "TRIGGER", label: "Quando…", config: { trigger_type: "contact_tag_added", config: { tag: TAG } }, position_x: 80, position_y: 80 },
    {
      id: msg, organization_id: ORG, flow_id: id, type: "MESSAGE", label: "Mensagem antiga",
      config: { window_mode: "outside_24h", template_name: templateName, template_language: "pt_BR", template_values: { "1": "{{contact.name}}" } },
      position_x: 400, position_y: 80,
    },
  ]);
  await admin.from("flow_edges").insert({ organization_id: ORG, flow_id: id, source_node_id: gatilho, target_node_id: msg });
  return id;
}

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
  sessaoA = await sessao(`Oficial E2E A ${ts}`, WABA_A);
  await sessao(`Oficial E2E B ${ts}`, WABA_B);
  await modelo(MODELO, WABA_A, "APPROVED", COMPONENTES);
  await modelo(PAUSADO, WABA_A, "PAUSED", SIMPLES);
  await modelo(OUTRA_CONTA, WABA_B, "APPROVED", SIMPLES);
  fluxoAntigoComCorrespondencia = await fluxoAntigo(`E2E antigo com modelo ${ts}`, MODELO);
  fluxoAntigoSemCorrespondencia = await fluxoAntigo(`E2E antigo sem modelo ${ts}`, `nao_existe_${ts}`);
});

test.afterAll(async () => {
  if (!admin) return;
  if (criados.fluxos.length) await admin.from("flows").delete().in("id", criados.fluxos);
  if (criados.modelos.length) await admin.from("meta_templates").delete().in("id", criados.modelos);
  if (criados.sessoes.length) await admin.from("channel_sessions").delete().in("id", criados.sessoes);
});

test.describe.configure({ mode: "serial", timeout: 180_000 });
// O canvas precisa de espaço para o card da mensagem e o do fim caberem juntos
// na tela — a ligação da saída é um ARRASTO de verdade, de bolinha a bolinha.
test.use({ viewport: { width: 1680, height: 1050 } });

test("A+B+C · novo fluxo no construtor, gatilho, modelo aprovado e saída de botão", async ({ page }) => {
  await login(page);
  await page.goto(`${APP_URL}/app/flows`);

  // ── A. Novo flow abre direto no construtor ──
  await page.getByTestId("novo-fluxo").click();
  await page.waitForURL(/\/app\/flows\/[0-9a-f-]{36}$/);
  const fluxoId = page.url().split("/").pop()!;
  criados.fluxos.push(fluxoId);

  await expect(page.getByTestId("nome-do-fluxo")).toHaveValue("Sem título");
  // Fluxo de Automações: o "‹ voltar" do topo leva à lista de Fluxos.
  await expect(page.getByTestId("voltar-do-fluxo")).toHaveAttribute("href", "/app/flows");
  await expect(page.getByTestId("voltar-do-fluxo")).toHaveText("Fluxos");
  // O "Quando…" nasce selecionado e o seletor de gatilho abre sozinho.
  const seletorDeGatilho = page.getByRole("dialog", { name: "Iniciar automação quando…" });
  await expect(seletorDeGatilho).toBeVisible();
  await foto(page, "01-novo-fluxo-abre-no-construtor");

  // Fechar o seletor deixa continuar: o painel do "Quando…" fica com "+ Novo gatilho".
  await page.keyboard.press("Escape");
  await expect(seletorDeGatilho).toBeHidden();
  await expect(page.getByTestId("novo-gatilho")).toBeVisible();
  await expect(page.getByTestId("card-novo-gatilho")).toBeVisible();
  await foto(page, "02-quando-sem-gatilho");

  // Salvar sem gatilho é permitido — e a linha fica sem gatilho, não com um inventado.
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Flow salvo.")).toBeVisible();
  const salvo = await admin.from("flows").select("trigger_type, status").eq("id", fluxoId).single();
  expect(salvo.data).toMatchObject({ trigger_type: null, status: "draft" });

  // Ativar sem gatilho é recusado, e a mensagem diz onde escolher.
  await page.getByRole("button", { name: "Ativar", exact: true }).click();
  await expect(page.getByText(/Escolha no passo "Quando…" o que inicia este flow/).first()).toBeVisible();
  await foto(page, "03-ativar-sem-gatilho-recusa");
  expect((await admin.from("flows").select("status").eq("id", fluxoId).single()).data?.status).toBe("draft");

  // "+ Novo gatilho" → "Tag atribuída ao contato" → configurar a tag.
  await page.getByTestId("novo-gatilho").click();
  await seletorDeGatilho.getByRole("button", { name: /Tag atribuída ao contato/ }).click();
  await expect(seletorDeGatilho).toBeHidden();
  const campoDaTag = page.getByTestId("node-config-sheet").getByRole("textbox").nth(1);
  await campoDaTag.fill(TAG);
  await expect(page.getByTestId("node-config-sheet").getByRole("button", { name: "Tag atribuída ao contato" })).toBeVisible();

  // ── B. Passo de mensagem fora da janela ──
  await page.getByTestId("flow-add-step").click();
  await page.getByRole("dialog", { name: "Adicionar passo" }).getByRole("button", { name: "Mensagem", exact: true }).click();
  const painel = page.getByTestId("node-config-sheet");
  await painel.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Fora da janela de 24 horas (template)" }).click();
  await expect(painel.getByTestId("escolher-modelo")).toBeVisible();

  await painel.getByTestId("escolher-modelo").click();
  const seletor = page.getByRole("dialog", { name: "Escolher modelo de mensagem" });
  await expect(seletor).toBeVisible();
  // Dois números oficiais: o número é escolhido antes.
  await expect(seletor.getByText("Escolha o número que envia para ver os modelos dele.")).toBeVisible();
  await seletor.getByRole("combobox", { name: "Número que envia" }).click();
  await page.getByRole("option", { name: `Oficial E2E A ${ts}` }).click();

  const lista = seletor.getByTestId("seletor-de-modelo-lista");
  await expect(lista.getByTestId(`modelo-${MODELO}-pt_BR`)).toBeVisible();
  // Só aprovados, e só da conta do número escolhido.
  await expect(lista.getByTestId(`modelo-${PAUSADO}-pt_BR`)).toHaveCount(0);
  await expect(lista.getByTestId(`modelo-${OUTRA_CONTA}-pt_BR`)).toHaveCount(0);
  await foto(page, "04-seletor-so-aprovados-do-numero");

  // A busca filtra por nome.
  const busca = seletor.getByRole("textbox", { name: "Pesquisar modelo" });
  await busca.fill("nao-casa-com-nada");
  await expect(seletor.getByText("Nenhum modelo aprovado com esse nome.")).toBeVisible();
  await busca.fill(`pedido_${ts}`);
  await expect(lista.getByTestId(`modelo-${MODELO}-pt_BR`)).toBeVisible();

  await lista.getByTestId(`modelo-${MODELO}-pt_BR`).click();
  await expect(seletor).toBeHidden();

  // O painel mostra o modelo inteiro, vindo do catálogo.
  await expect(painel.getByTestId("modelo-escolhido")).toHaveText(MODELO);
  // Cabeçalho, corpo e rodapé — os `{{n}}` saem destacados, em elemento próprio.
  await expect(painel.getByText(/^Pedido/).first()).toBeVisible();
  await expect(painel.getByText(/saiu para entrega\./).first()).toBeVisible();
  await expect(painel.getByText("Loja E2E")).toBeVisible();
  for (const botao of ["Confirmar", "Parar mensagens"]) {
    await expect(painel.getByText(botao, { exact: true }).first()).toBeVisible();
  }
  // Botão de link aparece com o que ele faz — e não vira saída do passo.
  await expect(painel.getByText(/Rastrear\s*\(abre um link\)/).first()).toBeVisible();
  // Os espaços vêm do contrato — quatro campos, nenhum de chave digitada.
  const espacos = painel.getByRole("textbox", { name: /^Valor de \{\{/ });
  await expect(espacos).toHaveCount(4);
  await expect(painel.getByRole("textbox", { name: "Espaço do template" })).toHaveCount(0);
  const rotulos = await espacos.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(rotulos).toEqual([
    "Valor de {{1}} (cabeçalho)",
    "Valor de {{1}} (corpo)",
    "Valor de {{2}} (corpo)",
    "Valor de {{1}} (botão 3 (url))",
  ]);
  for (const campo of await espacos.all()) await campo.fill("{{contact.name}}");
  await foto(page, "05-painel-com-o-modelo-e-os-espacos");

  // ── C. Cada resposta rápida é uma saída do card ──
  const cardDaMensagem = page.locator(".react-flow__node-MESSAGE").first();
  await expect(cardDaMensagem.locator(".react-flow__handle.source")).toHaveCount(2);
  await expect(cardDaMensagem.locator('[data-handleid="button:0"]')).toHaveCount(1);
  await expect(cardDaMensagem.locator('[data-handleid="button:1"]')).toHaveCount(1);
  await expect(cardDaMensagem.getByText("Olá {{1}}", { exact: false }).first()).toBeVisible();

  // Um passo de Fim, e a saída "Parar mensagens" (button:1) ligada a ele.
  await page.getByTestId("flow-add-step").click();
  await page.getByRole("dialog", { name: "Adicionar passo" }).getByRole("button", { name: "Fim", exact: true }).click();
  const cardDoFim = page.locator(".react-flow__node-END").first();
  await page.keyboard.press("Escape");
  // Enquadra o desenho inteiro (o controle "fit view" do próprio React Flow).
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(400);
  const origem = await cardDaMensagem.locator('[data-handleid="button:1"]').boundingBox();
  const destino = await cardDoFim.locator(".react-flow__handle.target").boundingBox();
  if (!origem || !destino) throw new Error("handles fora da tela");
  await page.mouse.move(origem.x + origem.width / 2, origem.y + origem.height / 2);
  await page.mouse.down();
  await page.mouse.move(destino.x + destino.width / 2, destino.y + destino.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await foto(page, "06-saida-do-botao-ligada");

  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Flow salvo.").first()).toBeVisible();

  // O que foi GRAVADO: referência + retrato do modelo, a conexão, os valores e a aresta.
  const nos = await admin.from("flow_nodes").select("id, type, config").eq("flow_id", fluxoId);
  const msg = (nos.data ?? []).find((n) => n.type === "MESSAGE")!;
  const fim = (nos.data ?? []).find((n) => n.type === "END")!;
  const idDoModelo = (await admin.from("meta_templates").select("id").eq("name", MODELO).single()).data?.id;
  expect(msg.config).toMatchObject({
    window_mode: "outside_24h",
    template_id: idDoModelo,
    template_name: MODELO,
    template_language: "pt_BR",
    template_contract_hash: hashContract(COMPONENTES, "POSITIONAL"),
    channel_session_id: sessaoA,
    buttons: [{ label: "Confirmar" }, { label: "Parar mensagens" }],
  });
  expect(Object.keys((msg.config as { template_values: object }).template_values).sort()).toEqual(
    ["1", "2", "button2:1", "header:1"].sort(),
  );
  const arestas = await admin.from("flow_edges").select("source_node_id, target_node_id, source_handle").eq("flow_id", fluxoId);
  expect(arestas.data).toContainEqual({ source_node_id: msg.id, target_node_id: fim.id, source_handle: "button:1" });
  const linha = await admin.from("flows").select("trigger_type, trigger_config").eq("id", fluxoId).single();
  expect(linha.data).toMatchObject({ trigger_type: "contact_tag_added", trigger_config: { tag: TAG } });

  // Com gatilho e modelo válidos, liga.
  await page.getByRole("button", { name: "Ativar", exact: true }).click();
  await expect(page.getByText("Flow ativado.")).toBeVisible();
  expect((await admin.from("flows").select("status").eq("id", fluxoId).single()).data?.status).toBe("active");
  await foto(page, "07-fluxo-ativado");
});

test("D · fluxo antigo: com correspondência oferece vincular; sem, avisa que não localizou", async ({ page }) => {
  await login(page);

  await page.goto(`${APP_URL}/app/flows/${fluxoAntigoComCorrespondencia}`);
  const cardAntigo = page.locator(".react-flow__node-MESSAGE").first();
  await expect(cardAntigo.getByText("Loja E2E", { exact: false }).or(cardAntigo.getByText("Olá {{1}}", { exact: false })).first()).toBeVisible();
  await cardAntigo.click();
  const painel = page.getByTestId("node-config-sheet");
  await expect(painel.getByText("Configurado pelo nome, antes do seletor.")).toBeVisible();
  await foto(page, "08-antigo-com-correspondencia");
  await painel.getByRole("button", { name: "Vincular a este modelo" }).click();
  await expect(painel.getByText("Configurado pelo nome, antes do seletor.")).toHaveCount(0);
  await expect(painel.getByRole("textbox", { name: /^Valor de \{\{/ })).toHaveCount(4);

  await page.goto(`${APP_URL}/app/flows/${fluxoAntigoSemCorrespondencia}`);
  const cardSem = page.locator(".react-flow__node-MESSAGE").first();
  await expect(cardSem.getByTestId("modelo-nao-localizado")).toBeVisible();
  await cardSem.click();
  await expect(page.getByTestId("node-config-sheet").getByRole("alert")).toContainText("Modelo não localizado no catálogo");
  // O editor antigo dos espaços continua, para não perder o que já estava configurado.
  await expect(page.getByTestId("node-config-sheet").getByRole("textbox", { name: "Espaço do template" })).toHaveCount(1);
  await foto(page, "09-antigo-sem-correspondencia");
});
