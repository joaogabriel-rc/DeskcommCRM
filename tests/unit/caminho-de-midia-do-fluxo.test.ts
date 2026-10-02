import { describe, expect, it } from "vitest";

import { arquivoDoCaminho, caminhoDeMidiaDoFluxo } from "@/lib/flows/caminho-de-midia";

/**
 * O CAMINHO DA IMAGEM DE UM FLUXO só passa no formato exato
 * `<org>/flows/<fluxo>/<arquivo>` — com organização e fluxo comparados por
 * igualdade com os valores confiáveis de quem chama. O motor de envio e a
 * duplicação usam o caminho com o client ADMIN do Storage; tudo o que escapar
 * desta tabela poderia ler o arquivo de outra pasta.
 *
 * Sabotagem medida: voltar à régua antiga (`startsWith("<org>/flows/")`) deixa
 * vermelhos os casos de `..`, outro fluxo, segmentos a mais e codificado.
 */

const ORG = "3a1b8c2d-0000-4000-8000-000000000001";
const FLUXO = "9f8e7d6c-0000-4000-8000-000000000002";
const OUTRO_FLUXO = "9f8e7d6c-0000-4000-8000-000000000003";
const OUTRA_ORG = "3a1b8c2d-0000-4000-8000-000000000009";
const ARQ = "0d5f1c4e-1111-4222-8333-444455556666.jpg";

describe("caminhoDeMidiaDoFluxo", () => {
  it.each([
    ["o formato que o upload monta (<uuid>.<ext>)", `${ORG}/flows/${FLUXO}/${ARQ}`],
    ["nome simples com extensão", `${ORG}/flows/${FLUXO}/foto.png`],
    ["hífen e sublinhado no nome", `${ORG}/flows/${FLUXO}/capa_aula-03.webp`],
  ])("aceita: %s", (_d, caminho) => {
    expect(caminhoDeMidiaDoFluxo(caminho, ORG, FLUXO)).toBe(true);
  });

  it.each([
    ["../ no lugar do arquivo", `${ORG}/flows/${FLUXO}/../${ARQ}`],
    ["../../ para fora da organização", `${ORG}/flows/${FLUXO}/../../${OUTRA_ORG}/conv/${ARQ}`],
    [".. como nome do arquivo", `${ORG}/flows/${FLUXO}/..`],
    ["arquivo começando por ponto", `${ORG}/flows/${FLUXO}/.env`],
    ["dois pontos no nome", `${ORG}/flows/${FLUXO}/a..jpg`],
    ["organização diferente", `${OUTRA_ORG}/flows/${FLUXO}/${ARQ}`],
    ["fluxo diferente (mesma organização)", `${ORG}/flows/${OUTRO_FLUXO}/${ARQ}`],
    ["pasta que não é flows", `${ORG}/avatars/${FLUXO}/${ARQ}`],
    ["formato incompleto: sem arquivo", `${ORG}/flows/${FLUXO}`],
    ["formato incompleto: termina em barra", `${ORG}/flows/${FLUXO}/`],
    ["segmento extra no meio", `${ORG}/flows/${FLUXO}/sub/${ARQ}`],
    ["barra dupla", `${ORG}/flows//${FLUXO}/${ARQ}`],
    ["barra inicial", `/${ORG}/flows/${FLUXO}/${ARQ}`],
    ["traversal codificado (%2e%2e)", `${ORG}/flows/${FLUXO}/%2e%2e%2f${ARQ}`],
    ["barra codificada (%2f)", `${ORG}/flows/${FLUXO}/x%2f..%2fy.jpg`],
    ["contrabarra", `${ORG}/flows/${FLUXO}/..\\${ARQ}`],
    ["espaço", `${ORG}/flows/${FLUXO}/a b.jpg`],
    ["sem extensão", `${ORG}/flows/${FLUXO}/arquivo`],
    ["byte nulo", `${ORG}/flows/${FLUXO}/a.jpg\u0000.png`],
    ["vazio", ""],
  ])("recusa: %s", (_d, caminho) => {
    expect(caminhoDeMidiaDoFluxo(caminho, ORG, FLUXO)).toBe(false);
  });

  it("recusa quando quem chama não sabe a organização ou o fluxo, e quando não é texto", () => {
    expect(caminhoDeMidiaDoFluxo(`${ORG}/flows/${FLUXO}/${ARQ}`, "", FLUXO)).toBe(false);
    expect(caminhoDeMidiaDoFluxo(`${ORG}/flows/${FLUXO}/${ARQ}`, ORG, "")).toBe(false);
    expect(caminhoDeMidiaDoFluxo(null, ORG, FLUXO)).toBe(false);
    expect(caminhoDeMidiaDoFluxo({ toString: () => `${ORG}/flows/${FLUXO}/${ARQ}` }, ORG, FLUXO)).toBe(false);
  });

  it("arquivoDoCaminho devolve só o nome do arquivo de um caminho válido", () => {
    expect(arquivoDoCaminho(`${ORG}/flows/${FLUXO}/${ARQ}`)).toBe(ARQ);
  });
});
