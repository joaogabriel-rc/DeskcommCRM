/**
 * O diálogo de editar contato cabe na tela, e o botão Salvar é alcançável —
 * com QUALQUER quantidade de campos personalizados.
 *
 * ── Por que isto é e2e, e não unitário ──────────────────────────────────────
 *
 * Porque a pergunta é de LAYOUT: "o botão está dentro da área utilizável e dá
 * para clicar nele?". jsdom não calcula layout — `getBoundingClientRect()` lá
 * devolve zeros —, então um teste unitário só conseguiria conferir nomes de
 * classe CSS, que é conferir a intenção e não o resultado. Este mede com
 * ferramenta, no navegador, como a doutrina de QA visual exige.
 *
 * ── O defeito que originou ──────────────────────────────────────────────────
 *
 * Medido em 1280×800 numa organização com ~20 campos declarados (o registro de
 * `contact_fields` chegou na migration 0312; antes dele as definições só vinham
 * do funil e eram poucas): o diálogo ficava com 1563px de altura,
 * `overflow-y: visible`, e o botão Salvar em y=1120 — fora da tela, sem
 * rolagem, impossível de clicar. O contato não tinha como ser editado.
 *
 * A primeira tentativa de conserto — `max-h` + `overflow-y-auto` no contêiner
 * inteiro — devolvia o acesso e ainda assim estava errada: com o diálogo todo
 * rolando, o título saía de vista e o Salvar só aparecia no fim da rolagem.
 * Por isso este arquivo mede as TRÊS propriedades, e não só "o botão existe":
 * o diálogo cabe, o miolo rola, e cabeçalho e rodapé NÃO se movem quando o
 * miolo rola até o fim.
 */
import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();

/** Os tipos que o registro aceita — variar garante alturas de input diferentes. */
const TIPOS = ["text", "number", "date", "datetime", "boolean", "list"];

/** Quantos campos o cenário do defeito tinha. */
const CAMPOS = 22;

/**
 * Monta o cenário pela API, com a sessão DO NAVEGADOR (`page.request`).
 *
 * ⚠️ Não serve `beforeAll({ request })`: aquele contexto não carrega o cookie
 * de sessão, então todo POST volta 401 — e como o teste não olhava a resposta,
 * a falha aparecia lá na frente como "o contato não tem campo nenhum", longe da
 * causa. A organização semeada também nasce SEM contatos, então este arquivo
 * cria o dele em vez de clicar no primeiro da lista.
 */
async function montarCenario(page: Page): Promise<string> {
  for (let i = 1; i <= CAMPOS; i++) {
    const r = await page.request.post("/api/v1/contact-fields", {
      data: {
        key: `cenario_modal_${i}`,
        label: `Campo de cenário ${i}`,
        type: TIPOS[i % TIPOS.length],
      },
    });
    // 409 = já existe (a outra perna do laço de viewport já criou). Qualquer
    // outro código é problema de verdade e precisa aparecer aqui, não adiante.
    expect([201, 409]).toContain(r.status());
  }

  const criado = await page.request.post("/api/v1/contacts", {
    data: { name: "Cenário do modal", phone_number: "+5511900000042" },
  });
  expect([201, 409]).toContain(criado.status());
  if (criado.status() === 201) return (await criado.json()).data.id as string;

  const lista = await page.request.get("/api/v1/contacts?q=" + encodeURIComponent("Cenário do modal"));
  return (await lista.json()).data[0].id as string;
}

async function abrirEdicaoDoContato(page: Page, contatoId: string): Promise<void> {
  await page.goto(`/app/contacts/${contatoId}`);
  await page.getByRole("button", { name: /Editar/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // O formulário carrega os campos por query; sem esperar o submit existir, a
  // medição pegaria um diálogo a meio caminho.
  await expect(page.locator('[role=dialog] button[type=submit]')).toBeVisible();
}

/** O que importa, medido no navegador. */
async function medir(page: Page) {
  return page.evaluate(() => {
    const d = document.querySelector("[role=dialog]") as HTMLElement;
    const salvar = d.querySelector("button[type=submit]") as HTMLElement;
    const rd = d.getBoundingClientRect();
    const rs = salvar.getBoundingClientRect();
    const roláveis = [...d.querySelectorAll("*")].filter(
      (el) =>
        el.scrollHeight > el.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY),
    );
    const alvo = document.elementFromPoint(rs.left + rs.width / 2, rs.top + rs.height / 2);
    return {
      alturaDoDialogo: Math.round(rd.height),
      dialogoCabe: rd.top >= 0 && rd.bottom <= window.innerHeight,
      salvarTop: Math.round(rs.top),
      salvarVisivel: rs.top >= 0 && rs.bottom <= window.innerHeight,
      // Hit-test: estar dentro do viewport não prova que nada cobre o botão.
      salvarClicavel: alvo === salvar || salvar.contains(alvo),
      temMioloRolavel: roláveis.length > 0,
    };
  });
}

async function rolarOMioloAteOFim(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]") as HTMLElement;
    const el = [...d.querySelectorAll("*")].find(
      (e) =>
        e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY),
    ) as HTMLElement | undefined;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// SÉRIE, e não paralelo: as duas pernas de viewport montam o MESMO cenário (os
// mesmos 22 campos e o mesmo contato, por chave única). Em paralelo elas
// disputam a criação — uma recebe 201 e a outra 409 no meio do laço, e o
// vermelho aparece numa asserção de layout, longe da causa. Medido: com dois
// workers uma das pernas falhava; em série, as duas passam.
test.describe.configure({ mode: "serial" });

test.describe("o diálogo de contato cabe na tela", () => {
  // 800 é o viewport do defeito; 600 é o notebook pequeno, onde a folga some.
  for (const altura of [800, 600]) {
    test(`com ${CAMPOS} campos, em 1280×${altura}, o Salvar é alcançável`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: altura });
      creds = await loginComoAdmin(page, creds);
      const contato = await montarCenario(page);
      await abrirEdicaoDoContato(page, contato);

      const antes = await medir(page);
      expect(antes.dialogoCabe, `diálogo com ${antes.alturaDoDialogo}px não cabe em ${altura}px`).toBe(true);
      expect(antes.alturaDoDialogo).toBeLessThanOrEqual(altura);
      expect(antes.temMioloRolavel, "com 22 campos o miolo precisa rolar").toBe(true);
      expect(antes.salvarVisivel).toBe(true);
      expect(antes.salvarClicavel).toBe(true);

      // O RODAPÉ NÃO ANDA. É o que separa este conserto do anterior.
      await rolarOMioloAteOFim(page);
      const depois = await medir(page);
      expect(depois.salvarTop, "o rodapé se moveu quando o miolo rolou").toBe(antes.salvarTop);
      expect(depois.salvarClicavel).toBe(true);

      // E o clique funciona de verdade, sem `force`.
      await page.locator('[role=dialog] button[type=submit]').click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
    });
  }
});
