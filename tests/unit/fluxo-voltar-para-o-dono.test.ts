import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { voltarDoFluxo } from "@/lib/flows/voltar";

/**
 * O "‹ voltar" do construtor acompanha o DONO do fluxo.
 *
 * O construtor é um só para os dois contextos (Rodada 2). O fluxo de um disparo
 * não aparece em Automações: voltar para lá deixaria o operador numa lista onde
 * o que ele estava editando não está. A prova pela tela está nos e2e
 * `fluxo-construtor-e-modelo-aprovado.spec.ts` (fluxo comum) e
 * `disparo-guiado-e-com-fluxo.spec.ts` (fluxo de disparo).
 */
describe("para onde o construtor volta", () => {
  it("A · fluxo de Automações → lista de Fluxos", () => {
    expect(voltarDoFluxo({ broadcast_id: null })).toEqual({ href: "/app/flows", rotulo: "Fluxos" });
    expect(voltarDoFluxo({})).toEqual({ href: "/app/flows", rotulo: "Fluxos" });
  });

  it("B · fluxo de disparo → o DISPARO dono", () => {
    expect(voltarDoFluxo({ broadcast_id: "b-123" })).toEqual({ href: "/app/disparos/b-123", rotulo: "Disparo" });
  });

  it("a página do construtor usa a regra — não um link fixo para /app/flows", () => {
    const pagina = readFileSync("app/app/flows/[id]/page.tsx", "utf8");
    expect(pagina).toMatch(/voltarDoFluxo\(/);
    expect(pagina).not.toMatch(/href="\/app\/flows"/);
  });
});
