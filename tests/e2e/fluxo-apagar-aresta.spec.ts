/**
 * APAGAR SÓ A LINHA ENTRE DOIS PASSOS — pela tela, e ela não volta.
 *
 * O caso que o operador reportou, dirigido como ele faria:
 *
 *   1. liga o "Próximo passo" de uma mensagem a um passo (B), arrastando;
 *   2. clica na linha (ela fica selecionada) e apaga pela lixeira que aparece;
 *   3. a linha some, os dois passos ficam no canvas;
 *   4. liga a mesma saída em OUTRO passo (C) e salva;
 *   5. recarrega: só A→C existe — na tela e no banco;
 *   6. a saída de um BOTÃO também se apaga (pela tecla Delete) sem apagar o
 *      botão nem o nó, e o botão de link (URL) não tem saída nenhuma;
 *   7. um botão CRIADO PELA TELA (id = UUID, saída `button:<uuid>` de 43
 *      caracteres) tem a saída ligada e o "Salvar" é aceito — o schema antigo
 *      (`max(40)`) respondia "Dados inválidos" aqui, e os casos acima não
 *      pegavam porque semeiam ids curtos (`b1`).
 *
 * O fluxo é semeado aqui, como RASCUNHO (fluxo ativo é só leitura no canvas),
 * por service role com sufixo único — e removido no fim. Nada envia WhatsApp.
 *
 * Evidência: `evidence/fluxo-apagar-aresta/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "fluxo-apagar-aresta");
const ts = Date.now();

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;

let admin: SupabaseClient;
let fluxoId = "";
const T = crypto.randomUUID();
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const C = crypto.randomUUID();

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

const card = (page: Page, id: string) => page.getByTestId(`node-card-${id}`);
const linha = (page: Page, de: string, para: string) => page.getByLabel(`Edge from ${de} to ${para}`, { exact: true });

/** Arrasta de uma saída até a entrada de um passo, como o mouse faria. */
async function ligar(page: Page, saida: Locator, destinoId: string): Promise<void> {
  const o = await saida.boundingBox();
  const d = await card(page, destinoId).locator(".react-flow__handle.target").boundingBox();
  if (!o || !d) throw new Error("handle fora da tela");
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 12 });
  await page.mouse.up();
}

/**
 * Clica NA linha: um ponto do meio do traçado, em coordenada de tela. O
 * traçado em degrau (smoothstep) tem quinas — o centro da caixa dela pode cair
 * fora do traço, então o ponto vem do próprio path.
 */
async function clicarNaLinha(page: Page, aresta: Locator): Promise<void> {
  const ponto = await aresta.locator("path.react-flow__edge-interaction").evaluate((el) => {
    const p = el as SVGPathElement;
    const local = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM()!;
    return { x: local.x * m.a + local.y * m.c + m.e, y: local.x * m.b + local.y * m.d + m.f };
  });
  await page.mouse.click(ponto.x, ponto.y);
}

async function arestasNoBanco(): Promise<string[]> {
  const { data, error } = await admin
    .from("flow_edges")
    .select("source_node_id, target_node_id, source_handle")
    .eq("flow_id", fluxoId);
  if (error) throw new Error(error.message);
  const nome = (id: string) => ({ [T]: "T", [A]: "A", [B]: "B", [C]: "C" })[id] ?? id;
  return (data ?? [])
    .map((e) => `${nome(e.source_node_id)}>${nome(e.target_node_id)}:${e.source_handle ?? "proximo"}`)
    .sort();
}

async function salvar(page: Page): Promise<void> {
  const resposta = page.waitForResponse((r) => r.url().endsWith(`/api/v1/flows/${fluxoId}/graph`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  expect((await resposta).status()).toBe(200);
  await expect(page.getByText("Flow salvo.").first()).toBeVisible();
}

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from("flows")
    .insert({ organization_id: ORG, name: `E2E aresta ${ts}`, status: "draft", trigger_type: "contact_tag_added", trigger_config: { tag: `E2E-AR-${ts}` } })
    .select("id")
    .single();
  if (error) throw new Error(`seed do fluxo: ${error.message}`);
  fluxoId = data.id as string;
  const base = { organization_id: ORG, flow_id: fluxoId };
  const nos = await admin.from("flow_nodes").insert([
    { ...base, id: T, type: "TRIGGER", label: "Quando…", config: { trigger_type: "contact_tag_added", config: { tag: `E2E-AR-${ts}` } }, position_x: 0, position_y: 120 },
    {
      ...base,
      id: A,
      type: "MESSAGE",
      label: "Mensagem A",
      config: {
        window_mode: "inside_24h",
        blocks: [
          {
            id: "t1",
            tipo: "texto",
            texto: "Posso confirmar sua presença?",
            botoes: [
              { id: "b1", rotulo: "Sim", acao: "fluxo" },
              { id: "b2", rotulo: "Ver site", acao: "url", url: "https://exemplo.test/aula" },
            ],
          },
        ],
      },
      position_x: 320,
      position_y: 80,
    },
    { ...base, id: B, type: "END", label: "Fim B", config: {}, position_x: 700, position_y: 0 },
    { ...base, id: C, type: "END", label: "Fim C", config: {}, position_x: 700, position_y: 320 },
  ]);
  if (nos.error) throw new Error(`seed dos nós: ${nos.error.message}`);
  const ar = await admin.from("flow_edges").insert({ ...base, source_node_id: T, target_node_id: A });
  if (ar.error) throw new Error(`seed da aresta: ${ar.error.message}`);
});

test.afterAll(async () => {
  if (fluxoId) await admin.from("flows").delete().eq("id", fluxoId);
});

test("a linha do Próximo passo se apaga, a saída fica livre, A→C fica e A→B não volta no reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto(`${APP_URL}/app/flows/${fluxoId}`);
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);

  // Fluxo antigo/semeado abre com a aresta que já tinha.
  await expect(linha(page, T, A)).toHaveCount(1);
  // Botão de URL não é saída: a mensagem tem "Sim" + "Próximo passo", e só.
  await expect(card(page, A).locator(".react-flow__handle.source")).toHaveCount(2);
  await expect(card(page, A).locator('[data-handleid="button:b1"]')).toHaveCount(1);
  await expect(card(page, A).locator('[data-handleid="button:b2"]')).toHaveCount(0);

  // ── 1. liga o Próximo passo em B ──
  const proximo = page.getByTestId(`proximo-passo-${A}`).locator(".react-flow__handle.source");
  await ligar(page, proximo, B);
  await expect(linha(page, A, B)).toHaveCount(1);
  await salvar(page);
  expect(await arestasNoBanco()).toEqual(["A>B:proximo", "T>A:proximo"]);
  await foto(page, "01-proximo-passo-ligado-em-B");

  // ── 2. seleciona a linha e apaga pela lixeira ──
  const ab = linha(page, A, B);
  await clicarNaLinha(page, ab);
  await expect(ab).toHaveClass(/selected/);
  const idAB = (await ab.getAttribute("data-id"))!;
  const lixeira = page.getByTestId(`apagar-aresta-${idAB}`);
  await expect(lixeira).toBeVisible();
  await foto(page, "02-linha-selecionada-com-lixeira");
  await lixeira.click();

  // ── 3. a linha sumiu; os dois passos continuam ──
  await expect(linha(page, A, B)).toHaveCount(0);
  await expect(card(page, A)).toBeVisible();
  await expect(card(page, B)).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await foto(page, "03-linha-apagada-passos-ficam");

  // ── 4. liga a mesma saída em C e salva ──
  await ligar(page, proximo, C);
  await expect(linha(page, A, C)).toHaveCount(1);
  await expect(linha(page, A, B)).toHaveCount(0);
  await salvar(page);
  expect(await arestasNoBanco()).toEqual(["A>C:proximo", "T>A:proximo"]);
  await foto(page, "04-religado-em-C-e-salvo");

  // ── 5. recarrega: A→B não volta ──
  await page.reload();
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });
  await expect(linha(page, A, C)).toHaveCount(1);
  await expect(linha(page, A, B)).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await foto(page, "05-depois-do-reload-so-A-C");
  // e salvar de novo, sem mexer, não ressuscita nada
  await salvar(page);
  expect(await arestasNoBanco()).toEqual(["A>C:proximo", "T>A:proximo"]);
});

test("a saída de um BOTÃO se apaga pela tecla Delete sem apagar o botão nem o nó", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto(`${APP_URL}/app/flows/${fluxoId}`);
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);

  await ligar(page, card(page, A).locator('[data-handleid="button:b1"]'), B);
  await expect(linha(page, A, B)).toHaveCount(1);
  await salvar(page);
  expect(await arestasNoBanco()).toEqual(["A>B:button:b1", "A>C:proximo", "T>A:proximo"]);

  const botao = linha(page, A, B);
  await clicarNaLinha(page, botao);
  await expect(botao).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect(linha(page, A, B)).toHaveCount(0);
  // o botão "Sim" continua no card, com a saída livre, e o nó está lá
  await expect(card(page, A).locator('[data-handleid="button:b1"]')).toHaveCount(1);
  await expect(card(page, A)).toContainText("Sim");
  await expect(linha(page, A, C)).toHaveCount(1);
  await foto(page, "06-saida-do-botao-apagada");

  await salvar(page);
  await page.reload();
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });
  await expect(linha(page, A, B)).toHaveCount(0);
  await expect(card(page, A)).toContainText("Sim");
  expect(await arestasNoBanco()).toEqual(["A>C:proximo", "T>A:proximo"]);
  const { data } = await admin.from("flow_nodes").select("config").eq("id", A).single();
  expect((data!.config as { blocks: Array<{ botoes: unknown[] }> }).blocks[0]!.botoes).toHaveLength(2);
  await foto(page, "07-reload-botao-intacto-sem-aresta");
});

test("um botão criado pela tela tem a saída button:<uuid> ligada e o Salvar é aceito", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto(`${APP_URL}/app/flows/${fluxoId}`);
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });

  // O botão nasce pelo editor de blocos, como o operador faz: o id é um UUID.
  await card(page, A).click();
  const editor = page.getByTestId("node-config-sheet").getByTestId("editor-de-blocos");
  await expect(editor).toBeVisible();
  await editor.getByTestId("adicionar-botao").click();
  const saidaNova = card(page, A).locator('[data-handleid^="button:"]:not([data-handleid="button:b1"])');
  await expect(saidaNova).toHaveCount(1);
  const handle = (await saidaNova.getAttribute("data-handleid"))!;
  expect(handle).toMatch(/^button:[0-9a-f-]{36}$/);
  expect(handle).toHaveLength(43);

  // Em 1440px o painel é uma coluna ao lado do canvas (não o cobre): reenquadra com ele aberto.
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);
  await ligar(page, saidaNova, B);
  await expect(linha(page, A, B)).toHaveCount(1);

  // `salvar` exige 200 e "Flow salvo." — era aqui que o 400 "Dados inválidos" aparecia.
  await salvar(page);
  await foto(page, "08-botao-criado-pela-tela-ligado-e-salvo");

  const { data: arestas, error } = await admin
    .from("flow_edges")
    .select("source_node_id, target_node_id, source_handle")
    .eq("flow_id", fluxoId)
    .eq("source_handle", handle);
  if (error) throw new Error(error.message);
  expect(arestas).toEqual([{ source_node_id: A, target_node_id: B, source_handle: handle }]);
  const { data: no } = await admin.from("flow_nodes").select("config").eq("id", A).single();
  const botoes = (no!.config as { blocks: Array<{ botoes: Array<{ id: string }> }> }).blocks[0]!.botoes;
  expect(botoes.map((b) => b.id)).toContain(handle.slice("button:".length));

  // e a ligação sobrevive ao reabrir
  await page.reload();
  await expect(card(page, A)).toBeVisible({ timeout: 30_000 });
  await expect(linha(page, A, B)).toHaveCount(1);
});
