/**
 * PROVA PELA TELA — variáveis dos modelos da Meta e o nó de mensagem em blocos.
 *
 *   A · Templates da Meta: `{{` abre o seletor de variáveis; o campo escolhido
 *       vira etiqueta; `{{var1}}` digitado inteiro também; um campo de exemplo
 *       por variável, na ordem do texto, que some quando a variável sai; o envio
 *       fica travado sem exemplo; `{{VAR1}}` é apontado. Nada é enviado à Meta.
 *   B · Automações: o nó antigo (texto + botão) abre como bloco; atraso, texto,
 *       imagem e botão de LINK entram no MESMO nó; o card mostra o "Próximo
 *       passo" separado da saída do botão; ligar o Próximo passo e salvar grava
 *       `config.blocks` e as duas arestas (a do botão e a padrão).
 *   C · Disparo em modo fluxo: o MESMO editor de blocos no construtor do disparo.
 *
 * Cenário semeado e removido pela própria spec (conexão oficial, fluxos, disparo).
 * Evidência em `evidence/mensagem-em-blocos/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "mensagem-em-blocos");
const ts = Date.now();

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;
const WABA = `6${String(ts).slice(-12)}1`;
const TAG = `E2E-BLOCOS-${ts}`;

/** Um PNG de 1×1 válido — o bastante para o upload e a prévia. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let admin: SupabaseClient;
const criados = { sessoes: [] as string[], fluxos: [] as string[], disparos: [] as string[] };
let fluxoAutomacao = "";
let noMensagem = "";
let noFim = "";
let fluxoDisparo = "";

function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: false });
}

async function loginGerente(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });

  const { data: s, error: es } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: ORG,
      provider: "meta_cloud",
      display_name: `Oficial Blocos ${ts}`,
      meta_phone_number_id: `5${String(ts).slice(-12)}`,
      meta_waba_id: WABA,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    })
    .select("id")
    .single();
  if (es) throw new Error(`seed da sessão: ${es.message}`);
  criados.sessoes.push(s.id as string);

  // B · um fluxo de Automação com o nó de mensagem NO FORMATO ANTIGO.
  const { data: f, error: ef } = await admin
    .from("flows")
    .insert({ organization_id: ORG, name: `E2E blocos ${ts}`, trigger_type: "contact_tag_added", trigger_config: { tag: TAG } })
    .select("id")
    .single();
  if (ef) throw new Error(`seed do fluxo: ${ef.message}`);
  fluxoAutomacao = f.id as string;
  criados.fluxos.push(fluxoAutomacao);
  const gatilho = crypto.randomUUID();
  noMensagem = crypto.randomUUID();
  noFim = crypto.randomUUID();
  await admin.from("flow_nodes").insert([
    { id: gatilho, organization_id: ORG, flow_id: fluxoAutomacao, type: "TRIGGER", label: "Quando…", config: { trigger_type: "contact_tag_added", config: { tag: TAG } }, position_x: 60, position_y: 120 },
    { id: noMensagem, organization_id: ORG, flow_id: fluxoAutomacao, type: "MESSAGE", label: "Enviar mensagem", config: { body: "Olá! Seu material está pronto.", buttons: [{ label: "Recebi" }] }, position_x: 380, position_y: 80 },
    { id: noFim, organization_id: ORG, flow_id: fluxoAutomacao, type: "END", label: "Fim", config: {}, position_x: 820, position_y: 120 },
  ]);
  await admin.from("flow_edges").insert([
    { organization_id: ORG, flow_id: fluxoAutomacao, source_node_id: gatilho, target_node_id: noMensagem },
    { organization_id: ORG, flow_id: fluxoAutomacao, source_node_id: noMensagem, target_node_id: noFim, source_handle: "button:0" },
  ]);

  // C · um disparo com fluxo próprio.
  const { data: d, error: ed } = await admin
    .from("broadcasts")
    .insert({ organization_id: ORG, name: `E2E disparo blocos ${ts}` })
    .select("id")
    .single();
  if (ed) throw new Error(`seed do disparo: ${ed.message}`);
  criados.disparos.push(d.id as string);
  const { data: fd, error: efd } = await admin
    .from("flows")
    .insert({ organization_id: ORG, name: `Disparo: blocos ${ts}`, trigger_type: "broadcast", broadcast_id: d.id })
    .select("id")
    .single();
  if (efd) throw new Error(`seed do fluxo do disparo: ${efd.message}`);
  fluxoDisparo = fd.id as string;
  criados.fluxos.push(fluxoDisparo);
  await admin.from("flow_nodes").insert({
    organization_id: ORG, flow_id: fluxoDisparo, type: "TRIGGER", label: "Quando…",
    config: { trigger_type: "broadcast", config: {} }, position_x: 60, position_y: 120,
  });
});

test.afterAll(async () => {
  if (!admin) return;
  if (criados.fluxos.length) await admin.from("flows").delete().in("id", criados.fluxos);
  if (criados.disparos.length) await admin.from("broadcasts").delete().in("id", criados.disparos);
  if (criados.sessoes.length) await admin.from("channel_sessions").delete().in("id", criados.sessoes);
  // A imagem que a spec subiu para a pasta do fluxo.
  const pasta = `${ORG}/flows/${fluxoAutomacao}`;
  const { data: arquivos } = await admin.storage.from("whatsapp-media").list(pasta);
  if (arquivos?.length) await admin.storage.from("whatsapp-media").remove(arquivos.map((a) => `${pasta}/${a.name}`));
});

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ viewport: { width: 1600, height: 1000 } });

test("A · Templates da Meta: {{ abre o seletor, a variável vira etiqueta e cada uma pede o seu exemplo", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`${APP_URL}/app/connections?aba=oficial&sub=templates`);
  await expect(page.getByTestId("templates-root")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("btn-criar-modelo").click();
  await page.getByTestId("criar-modelo-conexao").selectOption(criados.sessoes[0]!);
  await page.getByLabel("Nome do modelo").fill(`e2e_var_${ts}`);

  const corpo = page.getByTestId("modelo-corpo");
  await corpo.click();
  await page.keyboard.type("Olá ");
  await page.keyboard.type("{{");
  const seletor = page.getByTestId("seletor-de-variaveis");
  await expect(seletor).toBeVisible();
  await expect(seletor.getByRole("button", { name: "Campos do sistema" })).toBeVisible();
  await expect(seletor.getByRole("button", { name: "Campos personalizados do usuário" })).toBeVisible();
  await expect(seletor.getByRole("option", { name: "Primeiro nome" })).toBeVisible();
  await foto(page, "01-chaves-abrem-o-seletor");

  // Filtrar digitando depois das chaves, e escolher.
  await page.keyboard.type("prim");
  await expect(seletor.getByRole("option", { name: "Primeiro nome" })).toBeVisible();
  await expect(seletor.getByRole("option", { name: "E-mail" })).toHaveCount(0);
  await seletor.getByRole("option", { name: "Primeiro nome" }).click();
  await expect(seletor).toBeHidden();
  await expect(corpo.locator('[data-var="primeiro_nome"]')).toHaveText("Primeiro nome");

  // Variável livre digitada inteira vira etiqueta ao fechar as chaves.
  await page.keyboard.type(", seu pedido {{var1}} saiu.");
  await expect(corpo.locator('[data-var="var1"]')).toHaveCount(1);

  // A etiqueta é um token de verdade: medido, ela ocupa uma caixa própria na linha.
  const caixa = await corpo.locator('[data-var="primeiro_nome"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, editavel: (el as HTMLElement).isContentEditable, fundo: getComputedStyle(el).backgroundColor };
  });
  expect(caixa.w).toBeGreaterThan(20);
  expect(caixa.editavel).toBe(false);
  expect(caixa.fundo).not.toBe("rgba(0, 0, 0, 0)");

  // Uma amostra por variável, na ordem do texto; o envio espera por elas.
  const amostras = page.getByTestId("modelo-amostras");
  await expect(amostras).toBeVisible();
  await expect(amostras.getByText("Forneça amostras de suas variáveis")).toBeVisible();
  const campos = amostras.getByRole("textbox");
  await expect(campos).toHaveCount(2);
  expect(await campos.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual([
    "Exemplo da variável primeiro_nome",
    "Exemplo da variável var1",
  ]);
  const enviar = page.getByRole("button", { name: "Enviar para revisão" });
  await expect(enviar).toBeDisabled();
  await campos.nth(0).fill("João");
  await expect(enviar).toBeDisabled();
  await campos.nth(1).fill("#1234");
  await expect(enviar).toBeEnabled();
  await expect(page.locator("[data-previa-do-modelo]")).toContainText("{{primeiro_nome}}");
  await foto(page, "02-etiquetas-e-amostras");

  // Tirar a variável tira o exemplo dela.
  await corpo.locator('[data-var="var1"]').evaluate((el) => {
    const r = document.createRange();
    r.setStartAfter(el);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.press("Backspace");
  await expect(corpo.locator('[data-var="var1"]')).toHaveCount(0);
  await expect(campos).toHaveCount(1);

  // `{{VAR1}}` (o marcador que passava mudo) é apontado e trava o envio.
  await corpo.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" {{VAR1}}");
  await expect(page.getByTestId("modelo-problema")).toContainText("{{VAR1}} não é uma variável válida");
  await expect(enviar).toBeDisabled();
  await foto(page, "03-variavel-invalida-apontada");
});

test("B · Automações: vários blocos num nó, botão de link e o Próximo passo separado do botão", async ({ page }) => {
  await loginGerente(page);
  await page.goto(`${APP_URL}/app/flows/${fluxoAutomacao}`);
  const card = page.locator(".react-flow__node-MESSAGE").first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // O card do nó antigo já tem a saída do botão E o Próximo passo.
  await expect(card.locator('[data-handleid="button:0"]')).toHaveCount(1);
  await expect(card.getByTestId(`proximo-passo-${noMensagem}`)).toHaveText("Próximo passo");

  await card.click();
  const painel = page.getByTestId("node-config-sheet");
  const editor = painel.getByTestId("editor-de-blocos");
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId("bloco-texto")).toHaveCount(1);
  await expect(editor.getByRole("textbox", { name: "Texto da mensagem" })).toHaveValue("Olá! Seu material está pronto.");

  await editor.getByTestId("adicionar-atraso").click();
  await expect(editor.getByTestId("bloco-atraso")).toHaveCount(1);
  await expect(editor.getByRole("spinbutton", { name: "Duração do atraso" })).toHaveValue("3");

  await editor.getByTestId("adicionar-texto").click();
  await editor.getByRole("textbox", { name: "Texto da mensagem" }).nth(1).fill("Seu pedido saiu para entrega.");

  await editor.getByTestId("adicionar-imagem").click();
  const upload = page.waitForResponse((r) => r.url().includes(`/api/v1/flows/${fluxoAutomacao}/media`) && r.request().method() === "POST");
  await editor.getByLabel("Imagem do bloco").setInputFiles({ name: "pedido.png", mimeType: "image/png", buffer: PNG_1X1 });
  expect((await upload).status()).toBe(201);
  await expect(editor.getByRole("img", { name: "Imagem do bloco" })).toBeVisible();

  // Botão: vai para o último texto; vira "Abrir site" com a URL.
  await editor.getByTestId("adicionar-botao").click();
  const botao = editor.getByTestId("bloco-texto").nth(1).getByTestId("botao-do-bloco");
  await botao.getByRole("textbox", { name: "Título do botão" }).fill("VER PEDIDO");
  await botao.getByRole("combobox", { name: "Quando este botão é pressionado" }).click();
  await page.getByRole("option", { name: "Abrir site" }).click();
  await botao.getByRole("textbox", { name: "URL do site" }).fill("https://loja.test/pedido/123");

  // O card mostra a sequência; o botão de link NÃO vira saída.
  await expect(card.getByTestId("blocos-no-card")).toContainText("Aguardando por 3 s");
  await expect(card.getByTestId("blocos-no-card")).toContainText("VER PEDIDO");
  await expect(card.locator('[data-handleid^="button:"]')).toHaveCount(1);
  await foto(page, "04-blocos-no-mesmo-no");

  // Ligar o PRÓXIMO PASSO ao fim, ao lado da saída do botão.
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(400);
  const origem = await card.getByTestId(`proximo-passo-${noMensagem}`).locator(".react-flow__handle").boundingBox();
  const destino = await page.locator(".react-flow__node-END").first().locator(".react-flow__handle.target").boundingBox();
  if (!origem || !destino) throw new Error("handles fora da tela");
  await page.mouse.move(origem.x + origem.width / 2, origem.y + origem.height / 2);
  await page.mouse.down();
  await page.mouse.move(destino.x + destino.width / 2, destino.y + destino.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await foto(page, "05-proximo-passo-e-botao-ligados");

  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Flow salvo.").first()).toBeVisible();

  const { data: no } = await admin.from("flow_nodes").select("config").eq("id", noMensagem).single();
  const blocks = (no?.config as { blocks: Array<Record<string, unknown>> }).blocks;
  expect(blocks.map((b) => b.tipo)).toEqual(["texto", "atraso", "texto", "imagem"]);
  expect(blocks[0]).toMatchObject({ texto: "Olá! Seu material está pronto.", botoes: [{ id: "0", rotulo: "Recebi", acao: "fluxo" }] });
  expect(blocks[1]).toMatchObject({ segundos: 3 });
  expect(blocks[2]).toMatchObject({
    texto: "Seu pedido saiu para entrega.",
    botoes: [{ rotulo: "VER PEDIDO", acao: "url", url: "https://loja.test/pedido/123" }],
  });
  expect(String(blocks[3]!.media_storage_path)).toMatch(new RegExp(`^${ORG}/flows/${fluxoAutomacao}/.+\\.png$`));
  expect((no?.config as Record<string, unknown>).body).toBeUndefined();

  const { data: arestas } = await admin
    .from("flow_edges")
    .select("source_handle, target_node_id")
    .eq("flow_id", fluxoAutomacao)
    .eq("source_node_id", noMensagem);
  expect(arestas).toEqual(
    expect.arrayContaining([
      { source_handle: "button:0", target_node_id: noFim },
      { source_handle: null, target_node_id: noFim },
    ]),
  );
});

test("C · Disparo em modo fluxo: o mesmo editor de blocos", async ({ page }) => {
  await loginGerente(page);
  await page.goto(`${APP_URL}/app/flows/${fluxoDisparo}`);
  await expect(page.getByTestId("fluxo-do-disparo")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("flow-add-step").click();
  await page.getByRole("dialog", { name: "Adicionar passo" }).getByRole("button", { name: "Mensagem", exact: true }).click();
  const editor = page.getByTestId("node-config-sheet").getByTestId("editor-de-blocos");
  await expect(editor).toBeVisible();
  await editor.getByTestId("adicionar-texto").click();
  await editor.getByRole("textbox", { name: "Texto da mensagem" }).fill("Olá, {{contact.first_name}}!");
  await editor.getByTestId("adicionar-atraso").click();
  await editor.getByTestId("adicionar-texto").click();
  await editor.getByRole("textbox", { name: "Texto da mensagem" }).nth(1).fill("Temos novidades.");
  const card = page.locator(".react-flow__node-MESSAGE").first();
  await expect(card.getByTestId("blocos-no-card")).toContainText("Aguardando por 3 s");
  await expect(card.getByTestId(/^proximo-passo-/)).toBeVisible();
  await foto(page, "06-disparo-mesmo-editor");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Flow salvo.").first()).toBeVisible();
  const { data } = await admin.from("flow_nodes").select("config").eq("flow_id", fluxoDisparo).eq("type", "MESSAGE").single();
  expect(((data?.config as { blocks: Array<{ tipo: string }> }).blocks ?? []).map((b) => b.tipo)).toEqual([
    "texto",
    "atraso",
    "texto",
  ]);
});
