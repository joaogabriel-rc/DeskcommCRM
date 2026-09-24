/**
 * DISPAROS PELA TELA — público visual, modo guiado e modo fluxo (Rodada 2).
 *
 *   1. GUIADO: público (etiqueta COM VÍRGULA + campo "contém 50%") → modelo do
 *      catálogo → agendar. A prévia conta pela ROTA REAL (PostgREST de verdade:
 *      é aqui que as aspas e o escape de `%` são provados, não num dublê), e o
 *      número materializado é o número mostrado.
 *   2. FLUXO: modo fluxo → público → "Configurar fluxo" abre o MESMO construtor
 *      das automações → mensagem com modelo → salvar → voltar → agendar. O fluxo
 *      liga junto com o agendamento.
 *   3. EXECUÇÃO: o worker dos disparos (cron real) inicia a execução do fluxo
 *      para o destinatário, carregando a permissão materializada, e ela chega ao
 *      nó de MENSAGEM. O envio à Meta não é medido (sem credencial real): o que
 *      se mede é que a execução ENTROU na mensagem com a permissão do disparo, e
 *      que o erro, se houver, NÃO é de autorização.
 *   4. O fluxo do disparo NÃO aparece em Automações.
 *   5. Cross-tenant: o disparo de outra organização não é lido nem agendado.
 *
 * Cenário semeado AQUI por service role, com sufixo único, e removido no fim.
 * Evidência: `evidence/disparos-rodada2/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { hashContract } from "../../lib/channels/meta/contract-hash";
import { carregarEnvLocal, credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "disparos-rodada2");
const ts = Date.now();
const curto = String(ts).slice(-7);

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;

const WABA = `8${String(ts).slice(-12)}1`;
const MODELO = `e2e_r2_oferta_${ts}`;
const TAG_VIRGULA = `R2 Cliente, VIP ${curto}`;
const TAG_OUTRA = `R2 Outra ${curto}`;
const CAMPO = `plano_r2_${curto}`;
const COMPONENTES = [
  { type: "BODY", text: "Oferta para {{1}}" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quero" }, { type: "QUICK_REPLY", text: "Parar" }] },
];

let admin: SupabaseClient;
let sessao = "";
const criados = {
  sessoes: [] as string[],
  modelos: [] as string[],
  contatos: [] as string[],
  tags: [] as string[],
  campos: [] as string[],
  disparos: [] as string[],
  orgs: [] as string[],
};
let disparoDaOutraOrg = "";

function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function login(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function inserir<T extends Record<string, unknown>>(tabela: string, linha: T, lista: string[]): Promise<string> {
  const { data, error } = await admin.from(tabela).insert(linha).select("id").single();
  if (error) throw new Error(`seed ${tabela}: ${error.message}`);
  lista.push(data.id as string);
  return data.id as string;
}

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });

  sessao = await inserir(
    "channel_sessions",
    {
      organization_id: ORG,
      provider: "meta_cloud",
      display_name: `Oficial R2 ${curto}`,
      meta_phone_number_id: `pn-r2-${ts}`,
      meta_waba_id: WABA,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    },
    criados.sessoes,
  );
  await inserir(
    "meta_templates",
    {
      organization_id: ORG, waba_id: WABA, name: MODELO, language: "pt_BR", status: "APPROVED", category: "MARKETING",
      components: COMPONENTES, contract_hash: hashContract(COMPONENTES, "POSITIONAL"), parameter_format: "POSITIONAL",
    },
    criados.modelos,
  );
  await inserir("tags", { organization_id: ORG, name: TAG_VIRGULA }, criados.tags);
  await inserir("tags", { organization_id: ORG, name: TAG_OUTRA }, criados.tags);
  await inserir("contact_fields", { organization_id: ORG, key: CAMPO, label: `Plano R2 ${curto}`, type: "text" }, criados.campos);

  // c1: etiqueta com vírgula + "50% off" → ENTRA.
  // c2: mesma etiqueta + "500 off" → NÃO entra ("contém 50%" é literal: % não é curinga).
  // c3: outra etiqueta → NÃO entra.
  const fone = (n: number) => `+55119${String(ts).slice(-7)}${n}`;
  await inserir("contacts", { organization_id: ORG, name: `R2 Ana ${curto}`, phone_number: fone(1), tags: [TAG_VIRGULA], custom_fields: { [CAMPO]: "50% off" } }, criados.contatos);
  await inserir("contacts", { organization_id: ORG, name: `R2 Bia ${curto}`, phone_number: fone(2), tags: [TAG_VIRGULA], custom_fields: { [CAMPO]: "500 off" } }, criados.contatos);
  await inserir("contacts", { organization_id: ORG, name: `R2 Caio ${curto}`, phone_number: fone(3), tags: [TAG_OUTRA], custom_fields: { [CAMPO]: "50% off" } }, criados.contatos);
  // d4: o valor com os caracteres que NÃO podem virar sintaxe nem curinga.
  await inserir("contacts", { organization_id: ORG, name: `R2 Duda ${curto}`, phone_number: fone(4), tags: [TAG_VIRGULA], custom_fields: { [CAMPO]: 'x*y, "z" \\w' } }, criados.contatos);

  // Outra organização, com um disparo — para a prova cross-tenant.
  const outra = await inserir(
    "organizations",
    { slug: `e2e-r2-outra-${ts}`, legal_name: `E2E R2 Outra ${ts}`, display_name: `E2E R2 Outra ${ts}` },
    criados.orgs,
  );
  disparoDaOutraOrg = await inserir("broadcasts", { organization_id: outra, name: "Disparo alheio" }, criados.disparos);
});

test.afterAll(async () => {
  if (!admin) return;
  if (criados.disparos.length) await admin.from("broadcasts").delete().in("id", criados.disparos);
  if (criados.contatos.length) await admin.from("contacts").delete().in("id", criados.contatos);
  if (criados.modelos.length) await admin.from("meta_templates").delete().in("id", criados.modelos);
  if (criados.tags.length) await admin.from("tags").delete().in("id", criados.tags);
  if (criados.campos.length) await admin.from("contact_fields").delete().in("id", criados.campos);
  if (criados.sessoes.length) {
    await admin.from("conversations").delete().in("channel_session_id", criados.sessoes);
    await admin.from("channel_sessions").delete().in("id", criados.sessoes);
  }
  if (criados.orgs.length) await admin.from("organizations").delete().in("id", criados.orgs);
});

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.use({ viewport: { width: 1680, height: 1050 } });

/** Cria o disparo pela tela e devolve o id. */
async function novoDisparo(page: Page, nome: string): Promise<string> {
  await page.goto(`${APP_URL}/app/disparos`);
  await page.getByRole("button", { name: "Novo disparo" }).first().click();
  await page.locator("#disparo-nome").fill(nome);
  await page.getByRole("dialog").getByRole("button", { name: /^Criar/ }).click();
  await page.waitForURL(/\/app\/disparos\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  criados.disparos.push(id);
  return id;
}

/** O público do teste: etiqueta com vírgula E campo "contém 50%" — tudo por lista. */
async function montarPublico(page: Page): Promise<void> {
  const grupoE = page.getByTestId("grupo-fields");
  await grupoE.getByRole("combobox", { name: "Adicionar etiqueta" }).click();
  await page.getByRole("option", { name: TAG_VIRGULA, exact: true }).click();
  await expect(grupoE.getByText(TAG_VIRGULA, { exact: true })).toBeVisible();

  await page.getByTestId("adicionar-criterio-fields").click();
  await grupoE.getByRole("combobox", { name: "Campo" }).last().click();
  await page.getByRole("option", { name: `Plano R2 ${curto}`, exact: true }).click();
  await grupoE.getByRole("combobox", { name: "Operador" }).last().click();
  await page.getByRole("option", { name: "contém", exact: true }).click();
  await grupoE.getByRole("textbox", { name: "Valor" }).last().fill("50%");

  // A prévia conta pela rota real: só a Ana (etiqueta com vírgula + "50% off").
  await expect(page.getByTestId("previa-do-publico")).toHaveText("1 contato(s) agora", { timeout: 15_000 });
  const expressao = page.getByTestId("expressao-do-publico");
  await expect(expressao).toContainText(`tem "${TAG_VIRGULA}"`);
  await expect(expressao).toContainText(`${CAMPO} contém "50%"`);
}

async function escolherModelo(page: Page, escopo: ReturnType<Page["getByTestId"]>): Promise<void> {
  await escopo.getByTestId("escolher-modelo").click();
  const seletor = page.getByRole("dialog", { name: "Escolher modelo de mensagem" });
  const numero = seletor.getByRole("combobox", { name: "Número que envia" });
  if (await numero.isVisible().catch(() => false)) {
    await numero.click();
    await page.getByRole("option", { name: `Oficial R2 ${curto}` }).click();
  }
  await seletor.getByTestId(`modelo-${MODELO}-pt_BR`).click();
  await expect(seletor).toBeHidden();
  await escopo.getByRole("textbox", { name: /^Valor de \{\{1\}\}/ }).fill("{{contact.name}}");
}

test("0 · \"contém\" pelo PostgREST de verdade: `*`, `_`, vírgula, aspas e barra invertida são TEXTO", async ({ page }) => {
  await login(page);
  // Público: a etiqueta com vírgula (Ana "50% off", Bia "500 off", Duda 'x*y, "z" \w').
  // Um curinga contaria os 3; texto conta só quem tem aquele trecho.
  async function contar(valor: string): Promise<number> {
    const segmento = { tags_all: [TAG_VIRGULA], fields: [{ key: CAMPO, op: "contains", value: valor }] };
    const r = await page.request.get(`${APP_URL}/api/v1/broadcasts/previa?segmento=${encodeURIComponent(JSON.stringify(segmento))}`);
    expect(r.status(), `prévia de ${valor}`).toBe(200);
    return ((await r.json()) as { data: { total: number } }).data.total;
  }
  expect(await contar("*")).toBe(1);
  expect(await contar("x*y")).toBe(1);
  expect(await contar("_")).toBe(0);
  expect(await contar(",")).toBe(1);
  expect(await contar('"z"')).toBe(1);
  // Barra invertida literal: `\w` como regex acharia qualquer letra (os 3).
  expect(await contar("\\w")).toBe(1);
  expect(await contar("50%")).toBe(1);
  expect(await contar("off")).toBe(2);
});

test("1 · disparo GUIADO: público → modelo do catálogo → agendar; a materialização é o número mostrado", async ({ page }) => {
  await login(page);
  const id = await novoDisparo(page, `R2 guiado ${curto}`);
  await expect(page.getByTestId("modo-do-disparo")).toHaveText("Modo guiado");

  await montarPublico(page);
  await escolherModelo(page, page.locator("body"));
  await foto(page, "01-guiado-publico-e-modelo");

  await page.getByTestId("agendar-disparo").click();
  await expect(page.getByText("Disparo agendado.", { exact: false })).toBeVisible();

  const d = (await admin.from("broadcasts").select("status, total_recipients, message").eq("id", id).single()).data!;
  expect(d.status).toBe("scheduled");
  expect(d.total_recipients).toBe(1); // o MESMO número da prévia
  expect(d.message).toMatchObject({ template_name: MODELO, channel_session_id: sessao });
  const r = (await admin.from("broadcast_recipients").select("contact_id, service_boundary").eq("broadcast_id", id)).data!;
  expect(r).toHaveLength(1);
  expect(r[0]!.contact_id).toBe(criados.contatos[0]);
  // A permissão foi aberta NA CONVERSA do número do modelo.
  const conv = (await admin.from("conversations").select("channel_session_id").eq("id", (r[0]!.service_boundary as { conversation_id: string }).conversation_id).single()).data!;
  expect(conv.channel_session_id).toBe(sessao);
  await foto(page, "02-guiado-agendado");
});

test("2+3+4 · disparo com FLUXO: construtor, agendar, e a execução chega à mensagem com a permissão do disparo", async ({ page, request }) => {
  await login(page);
  const id = await novoDisparo(page, `R2 fluxo ${curto}`);
  await page.getByTestId("modo-fluxo").click();
  await expect(page.getByTestId("modo-do-disparo")).toHaveText("Modo fluxo");
  await expect(page.getByTestId("cartao-do-fluxo")).toBeVisible();
  await montarPublico(page);
  await foto(page, "03-fluxo-publico");

  // "Configurar fluxo" abre o MESMO construtor das automações.
  await page.getByTestId("configurar-fluxo").click();
  await page.waitForURL(/\/app\/flows\/[0-9a-f-]{36}$/);
  const fluxoId = page.url().split("/").pop()!;
  await expect(page.getByTestId("fluxo-do-disparo")).toBeVisible();
  // O "‹ voltar" do topo leva ao DISPARO dono — não a Automações.
  await expect(page.getByTestId("voltar-do-fluxo")).toHaveAttribute("href", `/app/disparos/${id}`);
  await expect(page.getByTestId("voltar-do-fluxo")).toHaveText("Disparo");
  await expect(page.getByRole("button", { name: "Ativar", exact: true })).toHaveCount(0);
  await page.locator(".react-flow__node-TRIGGER").first().click();
  await expect(page.getByTestId("gatilho-do-disparo")).toHaveText("O disparo alcança o contato");

  await page.getByTestId("flow-add-step").click();
  await page.getByRole("dialog", { name: "Adicionar passo" }).getByRole("button", { name: "Mensagem", exact: true }).click();
  const painel = page.getByTestId("node-config-sheet");
  await painel.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Fora da janela de 24 horas (template)" }).click();
  await escolherModelo(page, painel);
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Flow salvo.").first()).toBeVisible();
  await foto(page, "04-fluxo-do-disparo-no-construtor");

  // Voltar pelo link do topo cai no disparo, com o fluxo lá.
  await page.getByTestId("voltar-do-fluxo").click();
  await page.waitForURL(new RegExp(`/app/disparos/${id}$`));
  await expect(page.getByTestId("cartao-do-fluxo")).toBeVisible();

  // O fluxo do disparo não aparece em Automações.
  await page.goto(`${APP_URL}/app/flows`);
  await expect(page.getByText(`Disparo: R2 fluxo ${curto}`)).toHaveCount(0);

  await page.goto(`${APP_URL}/app/disparos/${id}`);
  await expect(page.getByTestId("previa-do-publico")).toHaveText("1 contato(s) agora", { timeout: 15_000 });
  await page.getByTestId("agendar-disparo").click();
  await expect(page.getByText("Disparo agendado.", { exact: false })).toBeVisible();
  expect((await admin.from("flows").select("status, broadcast_id").eq("id", fluxoId).single()).data).toEqual({
    status: "active",
    broadcast_id: id,
  });
  const rec = (await admin.from("broadcast_recipients").select("id").eq("broadcast_id", id)).data!;
  expect(rec).toHaveLength(1);
  await foto(page, "05-fluxo-agendado");

  // ── 3. O worker real: execução com a permissão do disparo, até a mensagem ──
  const segredo = process.env.INTERNAL_SECRET?.trim() || carregarEnvLocal().INTERNAL_SECRET?.trim();
  const tick = await request.post(`${APP_URL}/api/v1/cron/broadcast-worker`, {
    headers: { Authorization: `Bearer ${segredo}` },
    timeout: 60_000,
  });
  expect(tick.status()).toBe(200);

  const execucao = (
    await admin
      .from("flow_executions")
      .select("id, status, last_error, service_boundary, broadcast_recipient_id")
      .eq("flow_id", fluxoId)
      .single()
  ).data!;
  expect(execucao.broadcast_recipient_id).toBe(rec[0]!.id);
  const permissaoDoDestinatario = (await admin.from("broadcast_recipients").select("service_boundary").eq("id", rec[0]!.id).single()).data!;
  expect(execucao.service_boundary).toEqual(permissaoDoDestinatario.service_boundary);

  const noDaMensagem = (await admin.from("flow_nodes").select("id").eq("flow_id", fluxoId).eq("type", "MESSAGE").single()).data!;
  const entrou = (await admin.from("flow_execution_events").select("event_type").eq("execution_id", execucao.id).eq("node_id", noDaMensagem.id)).data!;
  expect(entrou.map((e) => e.event_type)).toContain("entered");
  // Se o envio falhou, foi na Meta (sem credencial real) — nunca por autorização.
  expect(String(execucao.last_error ?? "")).not.toMatch(/service_(stale|scope_mismatch|channel_mismatch)|sem_fronteira/);
  await page.reload();
  await foto(page, "06-fluxo-andamento");
});

test("5 · cross-tenant: o disparo de outra organização não é lido nem agendado", async ({ page }) => {
  await login(page);
  const ler = await page.request.get(`${APP_URL}/api/v1/broadcasts/${disparoDaOutraOrg}`);
  expect(ler.status()).toBe(404);
  const agendar = await page.request.patch(`${APP_URL}/api/v1/broadcasts/${disparoDaOutraOrg}`, { data: { acao: "agendar" } });
  expect(agendar.status()).toBe(404);
  expect((await admin.from("broadcasts").select("status").eq("id", disparoDaOutraOrg).single()).data?.status).toBe("draft");
  await page.goto(`${APP_URL}/app/disparos/${disparoDaOutraOrg}`);
  await expect(page.getByTestId("agendar-disparo")).toHaveCount(0);
});
