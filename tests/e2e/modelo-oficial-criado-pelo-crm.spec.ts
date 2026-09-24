/**
 * CRIAR MODELO OFICIAL PELO CRM (G1) — o que dá para provar pela tela sem a Meta.
 *
 * O envio para a Meta sai do SERVIDOR (`graph.facebook.com`), que o Playwright
 * não intercepta, e o rig não tem credencial real. O caminho feliz até a Meta
 * (pedido, id, PENDING no espelho, erros de credencial/conta/rede) está provado
 * em `tests/unit/meta-criar-modelo-oficial.test.ts`, com a rota e o banco de
 * verdade e só a rede dublada. Aqui, pela tela, como um admin faria:
 *
 *   A. "Criar modelo" abre o formulário compartilhado com o seletor do número
 *      oficial, e SEM o cabeçalho de mídia (a Meta exige o upload dela).
 *   B. Um nome que a Meta recusaria é barrado ANTES da Meta, e a frase chega
 *      limpa à tela; nada é gravado.
 *   C. Um modelo recém-criado (PENDING, com o id da Meta) aparece na lista com
 *      esse estado — e fica FORA do catálogo de utilizáveis que Fluxos e
 *      Disparos leem.
 *
 * Cenário semeado aqui por service role, com sufixo único, e removido no fim.
 * Evidência: `evidence/modelos-g1/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { hashContract } from "../../lib/channels/meta/contract-hash";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "modelos-g1");
const ts = Date.now();

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;
const WABA = `8${String(ts).slice(-12)}1`;
const PENDENTE = `e2e_g1_pendente_${ts}`;
const APROVADO = `e2e_g1_aprovado_${ts}`;
const CORPO = [{ type: "BODY", text: "Olá, seu pedido saiu." }];

let admin: SupabaseClient;
let sessao = "";
const modelos: string[] = [];

function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: false });
}

async function modelo(nome: string, status: string, providerTemplateId: string | null): Promise<void> {
  const { data, error } = await admin
    .from("meta_templates")
    .insert({
      organization_id: ORG,
      waba_id: WABA,
      name: nome,
      language: "pt_BR",
      status,
      category: "UTILITY",
      components: CORPO,
      contract_hash: hashContract(CORPO, "POSITIONAL"),
      parameter_format: "POSITIONAL",
      provider_template_id: providerTemplateId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed do modelo: ${error.message}`);
  modelos.push(data.id as string);
}

// Três testes, três logins de admin com MFA: o segundo login pode esperar uma
// janela TOTP inteira (30 s), que não cabe no teto padrão.
test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: ORG,
      provider: "meta_cloud",
      display_name: `Oficial G1 ${ts}`,
      meta_phone_number_id: `7${String(ts).slice(-12)}`,
      meta_waba_id: WABA,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed da sessão: ${error.message}`);
  sessao = data.id as string;
  // O estado de um modelo que acabou de ser criado pelo CRM: PENDING, com o id
  // que a Meta devolveu. E um aprovado da mesma conta, para comparar.
  await modelo(PENDENTE, "PENDING", `${ts}01`);
  await modelo(APROVADO, "APPROVED", null);
});

test.afterAll(async () => {
  if (modelos.length) await admin.from("meta_templates").delete().in("id", modelos);
  await admin.from("meta_templates").delete().eq("organization_id", ORG).eq("waba_id", WABA);
  if (sessao) await admin.from("channel_sessions").delete().eq("id", sessao);
});

test("A · Criar modelo abre o formulário compartilhado, com o número oficial e sem cabeçalho de mídia", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`${APP_URL}/app/connections?aba=oficial&sub=templates`);
  await expect(page.getByTestId("templates-root")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("btn-criar-modelo").click();
  const conexao = page.getByTestId("criar-modelo-conexao");
  await expect(conexao).toBeVisible();
  await expect(conexao.locator(`option[value="${sessao}"]`)).toHaveText(new RegExp(`Oficial G1 ${ts}`));
  await conexao.selectOption(sessao);

  await expect(page.getByLabel("Nome do modelo")).toBeVisible();
  await expect(page.getByLabel("Categoria")).toBeVisible();
  await expect(page.getByLabel("Conteúdo")).toBeVisible();
  // O cabeçalho de TEXTO existe; o de mídia não é oferecido no canal oficial.
  await expect(page.getByLabel("Cabeçalho de texto")).toBeVisible();
  await expect(page.getByText("Subir imagem (JPG/PNG)")).toHaveCount(0);
  await expect(page.getByLabel("Imagem do cabeçalho")).toHaveCount(0);
  await foto(page, "01-formulario-oficial");
});

test("B · nome que a Meta recusaria é barrado antes dela, com a frase limpa na tela, e nada é gravado", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`${APP_URL}/app/connections?aba=oficial&sub=templates`);
  await page.getByTestId("btn-criar-modelo").click();
  await page.getByTestId("criar-modelo-conexao").selectOption(sessao);

  await page.getByLabel("Nome do modelo").fill("Pedido Invalido");
  await page.getByLabel("Conteúdo").fill("Olá {{1}}, seu pedido saiu.");
  await page.getByLabel("Exemplo do valor 1").fill("Ana");

  const resposta = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/channels/templates") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Enviar para revisão" }).click();
  const r = await resposta;
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { details: { motivo: string } } }).error.details.motivo).toBe(
    "meta_template_validacao",
  );

  const aviso = page.getByText("O nome aceita só letras minúsculas, números e _ (ex.: confirmacao_de_pedido).");
  await expect(aviso).toBeVisible();
  await expect(page.getByText(/meta_template_validacao/)).toHaveCount(0);
  // Medido, não a olho: depois da animação de entrada, o aviso fica inteiro na
  // viewport e à frente do cabeçalho fixo (nenhum elemento o cobre no centro).
  await page.waitForTimeout(700);
  const medida = await aviso.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const noCentro = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, visivel: !!noCentro && (el === noCentro || el.contains(noCentro) || noCentro.contains(el)) };
  });
  expect(medida.top).toBeGreaterThanOrEqual(0);
  expect(medida.visivel).toBe(true);
  await foto(page, "02-recusa-local");

  const { count } = await admin
    .from("meta_templates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("waba_id", WABA);
  expect(count).toBe(2); // só os dois semeados
});

test("C · o modelo PENDENTE aparece na lista com o estado, e fica fora do catálogo de utilizáveis", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`${APP_URL}/app/connections?aba=oficial&sub=templates`);

  const cartao = page.getByTestId("template-card").filter({ hasText: PENDENTE });
  await expect(cartao).toBeVisible({ timeout: 30_000 });
  await expect(cartao.getByText("PENDING", { exact: true })).toBeVisible();
  await cartao.scrollIntoViewIfNeeded();
  await foto(page, "03-pendente-na-lista");

  // O catálogo que Fluxos e Disparos leem (o seletor pede só os utilizáveis),
  // perguntado DE DENTRO da página, com a sessão do operador — como o seletor faz.
  const catalogo = (todos: boolean) =>
    page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "same-origin" });
      return { status: r.status, corpo: (await r.json()) as { data: { modelos: Array<{ name: string; status: string; utilizavel: boolean }> } } };
    }, `/api/v1/channels/catalogo-de-modelos?channel_session_id=${sessao}${todos ? "&todos=1" : ""}`);

  const utilizaveis = await catalogo(false);
  expect(utilizaveis.status).toBe(200);
  const nomes = utilizaveis.corpo.data.modelos.map((m) => m.name);
  expect(nomes).toContain(APROVADO);
  expect(nomes).not.toContain(PENDENTE);

  const pendente = (await catalogo(true)).corpo.data.modelos.find((m) => m.name === PENDENTE);
  expect(pendente).toMatchObject({ status: "PENDING", utilizavel: false });
});
