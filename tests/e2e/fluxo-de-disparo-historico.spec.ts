/**
 * FLUXO DE DISPARO JÁ USADO: VER COMO HISTÓRICO, DUPLICAR, EDITAR A CÓPIA (migration 0507).
 *
 * O defeito: o fluxo de um disparo apontava para a definição VIVA. Depois de
 * enviado, "Ver fluxo" nem abria (etapa A); e, aberto por outro caminho, nada
 * impedia de reescrever o grafo — o que apagava o rastro de quem já tinha
 * passado por ele. A entrega: o fluxo usado vira HISTÓRICO (visível, não
 * editável, por nenhum caminho), e a saída é "Duplicar disparo".
 *
 * A jornada, pela tela, como um gestor faria:
 *   1. disparo concluído → "Ver fluxo" abre o construtor;
 *   2. o construtor diz que é a definição histórica: selo, aviso, sem Salvar;
 *      arrastar um passo NÃO move (medido pela posição do nó no canvas, não na
 *      tela: ali o arrasto vira pan); o painel
 *      do passo mostra a configuração com os campos desabilitados;
 *   3. a REST direta, com a sessão do próprio gestor, também é recusada (PT409)
 *      — a trava é do banco, não da tela;
 *   4. "Duplicar disparo" → rascunho novo "(cópia)" → "Abrir o Construtor" →
 *      editável: arrastar move, Salvar grava — e o fluxo de origem fica intacto.
 *
 * Semeia pelo service role do Supabase LOCAL (o `.env.e2e` recusa outro host):
 * disparo + fluxo em rascunho, depois o disparo vai a `completed` e ganha uma
 * execução com eventos — o estado que o motor deixaria.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds } from "./helpers/login-admin";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "fluxo-de-disparo-historico");
const curto = String(Date.now()).slice(-7);

const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
const ORG = creds.org_id;

let admin: SupabaseClient;
const ids = { disparo: "", fluxo: "", gatilho: "", mensagem: "", contato: "", execucao: "" };
const criados = { disparos: [] as string[] };

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

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, oque: string): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`seed ${oque}: ${error.message}`);
  return data as NonNullable<T>;
}

/**
 * Posição do nó NO CANVAS (coordenadas do fluxo): o `transform` que o React Flow
 * põe em `.react-flow__node`. Pan e zoom vão no `.react-flow__viewport` pai, então
 * ela só muda quando o PASSO se move — e é a que vai para `position_x/y`. A caixa
 * na TELA (`caixaDoNo`) muda também com pan: no construtor somente leitura o
 * gesto de arrastar faz pan, e a tela mede um movimento que o passo não fez.
 */
async function posicaoDoNo(page: Page, id: string) {
  const t = await page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(t);
  if (!m) throw new Error(`posição do nó ${id} ilegível: "${t}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Caixa do nó na tela — para o mouse saber onde pegar, não para medir movimento. */
async function caixaDoNo(page: Page, id: string) {
  const r = await page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  return r;
}

async function arrastar(page: Page, id: string, dx: number, dy: number) {
  const b = await caixaDoNo(page, id);
  await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.w / 2 + dx / 2, b.y + b.h / 2 + dy / 2, { steps: 5 });
  await page.mouse.move(b.x + b.w / 2 + dx, b.y + b.h / 2 + dy, { steps: 5 });
  await page.mouse.up();
}

test.beforeAll(async () => {
  const c = credenciaisSupabaseDeTeste();
  admin = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });

  const contato = await ok(
    admin
      .from("contacts")
      .insert({ organization_id: ORG, name: `Hist ${curto}`, phone_number: `+55119${curto}8` })
      .select("id")
      .single(),
    "contato",
  );
  ids.contato = contato.id as string;

  const disparo = await ok(
    admin
      .from("broadcasts")
      .insert({ organization_id: ORG, name: `Histórico ${curto}`, status: "draft", segment: { tags_all: ["x"] } })
      .select("id")
      .single(),
    "disparo",
  );
  ids.disparo = disparo.id as string;
  criados.disparos.push(ids.disparo);

  const fluxo = await ok(
    admin
      .from("flows")
      .insert({ organization_id: ORG, name: `Disparo: Histórico ${curto}`, trigger_type: "broadcast", broadcast_id: ids.disparo, status: "active" })
      .select("id")
      .single(),
    "fluxo",
  );
  ids.fluxo = fluxo.id as string;

  const nos = await ok(
    admin
      .from("flow_nodes")
      .insert([
        { organization_id: ORG, flow_id: ids.fluxo, type: "TRIGGER", label: "Quando…", config: { trigger_type: "broadcast", config: {} }, position_x: 80, position_y: 80 },
        { organization_id: ORG, flow_id: ids.fluxo, type: "MESSAGE", label: "Boas-vindas", config: { window_mode: "inside_24h", blocks: [{ id: "b1", tipo: "texto", texto: `Olá ${curto}` }] }, position_x: 420, position_y: 80 },
      ])
      .select("id, type"),
    "nós",
  );
  ids.gatilho = (nos as Array<{ id: string; type: string }>).find((n) => n.type === "TRIGGER")!.id;
  ids.mensagem = (nos as Array<{ id: string; type: string }>).find((n) => n.type === "MESSAGE")!.id;
  await ok(
    admin.from("flow_edges").insert({ organization_id: ORG, flow_id: ids.fluxo, source_node_id: ids.gatilho, target_node_id: ids.mensagem }),
    "aresta",
  );

  // O disparo saiu: concluído, com uma execução que passou pelos dois passos.
  await ok(admin.from("broadcasts").update({ status: "completed", started_at: new Date().toISOString(), finished_at: new Date().toISOString() }).eq("id", ids.disparo), "concluir");
  const exec = await ok(
    admin
      .from("flow_executions")
      .insert({ organization_id: ORG, flow_id: ids.fluxo, contact_id: ids.contato, status: "completed", current_node_id: ids.mensagem, completed_at: new Date().toISOString() })
      .select("id")
      .single(),
    "execução",
  );
  ids.execucao = exec.id as string;
  await ok(
    admin.from("flow_execution_events").insert([
      { organization_id: ORG, execution_id: ids.execucao, node_id: ids.gatilho, event_type: "entered" },
      { organization_id: ORG, execution_id: ids.execucao, node_id: ids.mensagem, event_type: "completed" },
    ]),
    "eventos",
  );
});

test.afterAll(async () => {
  // O histórico só sai sem execução: a limpeza do teste apaga a execução antes.
  if (ids.execucao) await admin.from("flow_executions").delete().eq("id", ids.execucao);
  for (const d of criados.disparos) await admin.from("broadcasts").delete().eq("id", d);
  if (ids.contato) await admin.from("contacts").delete().eq("id", ids.contato);
});

test("disparo concluído: o fluxo abre como histórico, nada o altera, e a cópia é editável", async ({ page }) => {
  await login(page);

  // ── 1. O disparo concluído mostra o aviso e abre o fluxo ────────────────────
  await page.goto(`${APP_URL}/app/disparos/${ids.disparo}`);
  const avisoDoDisparo = page.getByTestId("aviso-fluxo-protegido");
  await expect(avisoDoDisparo).toHaveAttribute("data-estado", "historico");
  await expect(page.getByTestId("configurar-fluxo")).toHaveText("Ver fluxo");
  await foto(page, "01-disparo-concluido-com-aviso");

  await page.getByTestId("configurar-fluxo").click();
  await page.waitForURL(new RegExp(`/app/flows/${ids.fluxo}$`));

  // ── 2. O construtor é somente leitura e diz por quê ─────────────────────────
  await expect(page.getByTestId("estado-do-fluxo")).toHaveText("Histórico");
  await expect(page.getByTestId("aviso-fluxo-protegido-titulo")).toHaveText("Definição histórica — somente leitura");
  await expect(page.getByTestId("salvar-fluxo")).toHaveCount(0);
  await expect(page.getByTestId("flow-add-step")).toHaveCount(0);
  await expect(page.locator(`.react-flow__node[data-id="${ids.mensagem}"]`)).toBeVisible();

  // O passo está onde o banco diz, e o arrasto não o tira de lá (vira pan da tela).
  expect(await posicaoDoNo(page, ids.mensagem)).toEqual({ x: 420, y: 80 });
  await arrastar(page, ids.mensagem, 160, 120);
  expect(await posicaoDoNo(page, ids.mensagem)).toEqual({ x: 420, y: 80 });

  // A configuração continua visível — é o histórico que se veio ver —, desabilitada.
  await page.locator(`.react-flow__node[data-id="${ids.mensagem}"]`).click();
  const painel = page.getByTestId("painel-somente-leitura");
  await expect(painel).toHaveAttribute("data-somente-leitura", "true");
  const desabilitado = await painel.evaluate((el) => (el as HTMLFieldSetElement).disabled);
  expect(desabilitado).toBe(true);
  const campoAtivo = await painel.evaluate(
    (el) => [...el.querySelectorAll("input, textarea, select, button")].filter((c) => !c.matches(":disabled")).length,
  );
  expect(campoAtivo).toBe(0);
  await foto(page, "02-construtor-historico-somente-leitura");

  // ── 3. A REST direta com a sessão do gestor também é recusada ──────────────
  const c = credenciaisSupabaseDeTeste();
  const comoGestor = createClient(c.url, c.anonKey, { auth: { persistSession: false } });
  const { error: loginErr } = await comoGestor.auth.signInWithPassword({ email: creds.users.manager!.email, password: creds.password });
  expect(loginErr).toBeNull();
  const { error: escrita } = await comoGestor.from("flow_nodes").delete().eq("id", ids.mensagem);
  expect(escrita?.code).toBe("PT409");
  expect(escrita?.message).toContain("flow_protegido:historico");
  const { count } = await admin.from("flow_nodes").select("id", { count: "exact", head: true }).eq("flow_id", ids.fluxo);
  expect(count).toBe(2);
  const { data: eventos } = await admin.from("flow_execution_events").select("node_id").eq("execution_id", ids.execucao);
  expect((eventos ?? []).every((e) => e.node_id !== null)).toBe(true);

  // ── 4. Duplicar → a cópia é rascunho e editável ─────────────────────────────
  await page.getByTestId("duplicar-disparo").click();
  await page.waitForURL(/\/app\/disparos\/[0-9a-f-]{36}$/);
  const copia = page.url().split("/").pop()!;
  expect(copia).not.toBe(ids.disparo);
  criados.disparos.unshift(copia);
  // Rascunho: o nome é um campo editável, e a cópia se anuncia como cópia.
  await expect(page.getByLabel("Nome do disparo")).toHaveValue(`Histórico ${curto} (cópia)`);
  await expect(page.getByTestId("aviso-fluxo-protegido")).toHaveCount(0);
  await expect(page.getByTestId("configurar-fluxo")).toHaveText("Abrir o Construtor de Fluxos");
  await foto(page, "03-copia-em-rascunho");

  await page.getByTestId("configurar-fluxo").click();
  await page.waitForURL(/\/app\/flows\/[0-9a-f-]{36}$/);
  const fluxoCopia = page.url().split("/").pop()!;
  expect(fluxoCopia).not.toBe(ids.fluxo);
  await expect(page.getByTestId("aviso-fluxo-protegido")).toHaveCount(0);
  await expect(page.getByTestId("salvar-fluxo")).toBeVisible();

  const { data: nosDaCopia } = await admin.from("flow_nodes").select("id, type, config").eq("flow_id", fluxoCopia);
  expect(nosDaCopia).toHaveLength(2);
  const msgCopia = (nosDaCopia as Array<{ id: string; type: string; config: Record<string, unknown> }>).find((n) => n.type === "MESSAGE")!;
  expect(msgCopia.id).not.toBe(ids.mensagem);
  expect(JSON.stringify(msgCopia.config)).toContain(`Olá ${curto}`);
  const { count: execCopia } = await admin.from("flow_executions").select("id", { count: "exact", head: true }).eq("flow_id", fluxoCopia);
  expect(execCopia).toBe(0);

  const antesCopia = await posicaoDoNo(page, msgCopia.id);
  await arrastar(page, msgCopia.id, 160, 120);
  const depoisCopia = await posicaoDoNo(page, msgCopia.id);
  expect(Math.abs(depoisCopia.x - antesCopia.x)).toBeGreaterThan(50);

  const salvou = page.waitForResponse((r) => r.url().endsWith(`/api/v1/flows/${fluxoCopia}/graph`) && r.request().method() === "PUT");
  await page.getByTestId("salvar-fluxo").click();
  expect((await salvou).status()).toBe(200);
  await foto(page, "04-copia-editada-e-salva");

  // Gravou na CÓPIA; a origem continua exatamente como estava.
  const { data: posCopia } = await admin.from("flow_nodes").select("position_x").eq("id", msgCopia.id).single();
  expect(Number(posCopia!.position_x)).toBeGreaterThan(420);
  const { data: posOrigem } = await admin.from("flow_nodes").select("position_x").eq("id", ids.mensagem).single();
  expect(Number(posOrigem!.position_x)).toBe(420);
});
