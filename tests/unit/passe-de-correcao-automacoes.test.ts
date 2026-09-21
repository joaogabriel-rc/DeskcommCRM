/**
 * O passe de correção das Automações: campos no contato, ativação que cobra o
 * flow inteiro, o seam do botão e os espaços do template.
 *
 * Cada bloco abaixo vigia um defeito que EXISTIU e foi medido, não uma
 * possibilidade imaginada.
 */
import { describe, expect, it } from "vitest";

import { camposDoContato } from "@/lib/contacts/campos-do-contato";
import { casarRespostaDeBotao } from "@/lib/flows/nodes/message";
import { proximoSlot, renomearSlot } from "@/lib/flows/slots";
import { problemasParaAtivar, type NoParaValidar } from "@/lib/flows/validacao";
import type { CampoDoContato } from "@/lib/schemas/contact-fields";

function campo(p: Partial<CampoDoContato> & { key: string }): CampoDoContato {
  return {
    id: `id-${p.key}`,
    label: p.label ?? p.key,
    description: null,
    type: p.type ?? "text",
    options: p.options ?? [],
    folder: "Campos do Usuário",
    archived_at: p.archived_at ?? null,
    position: 0,
    ...p,
  };
}

describe("o formulário do contato junta o registro com o legado do funil", () => {
  it("o registro vence quando a chave existe nas duas fontes", () => {
    // Era o risco do backfill: o campo existe no registro (com o tipo que a
    // tela nova editou) E no funil (com o tipo antigo). Mostrar os dois daria
    // dois inputs gravando na MESMA chave.
    const lista = camposDoContato(
      [campo({ key: "produto", label: "Produto de interesse", type: "text" })],
      [{ key: "produto", label: "Produto (funil)", type: "textarea" }],
    );
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ key: "produto", label: "Produto de interesse", type: "text" });
  });

  it("o campo que só existe no funil CONTINUA aparecendo", () => {
    // O funil segue editável depois da atualização, e um campo acrescentado lá
    // não passa por lugar nenhum que alimente o registro. Descartá-lo faria um
    // campo visível numa tela sumir da outra.
    const lista = camposDoContato([campo({ key: "produto" })], [{ key: "convenio", label: "Convênio", type: "text" }]);
    expect(lista.map((c) => c.key)).toEqual(["produto", "convenio"]);
  });

  it("a chave casa sem diferenciar caixa", () => {
    const lista = camposDoContato([campo({ key: "produto" })], [{ key: "PRODUTO", label: "x", type: "text" }]);
    expect(lista).toHaveLength(1);
  });

  it("campo ARQUIVADO some do formulário", () => {
    const lista = camposDoContato([campo({ key: "antigo", archived_at: "2026-01-01T00:00:00Z" })], []);
    expect(lista).toEqual([]);
  });

  it("tipo que o editor não conhece degrada para texto, em vez de sumir", () => {
    // Um `switch` sem caso devolveria o `default` do editor de qualquer jeito;
    // o que não pode é a definição ser descartada e o valor ficar ineditável.
    const lista = camposDoContato([campo({ key: "exotico", type: "geo" as never })], []);
    expect(lista[0]).toMatchObject({ key: "exotico", type: "text" });
  });

  it("os seis tipos da tela nova chegam intactos ao editor", () => {
    const tipos = ["text", "number", "date", "datetime", "boolean", "list"] as const;
    const lista = camposDoContato(
      tipos.map((t) => campo({ key: `c_${t}`, type: t })),
      [],
    );
    expect(lista.map((c) => c.type)).toEqual([...tipos]);
  });
});

describe("ligar um flow cobra o que falharia com um contato dentro", () => {
  const TRIGGER: NoParaValidar = {
    id: "n1",
    type: "TRIGGER",
    label: "",
    config: { trigger_type: "contact_tag_added" },
  };

  it("o defeito que motivou o arquivo: mensagem fora da janela SEM template", () => {
    // Antes disto, ativava sem reclamar e morria no primeiro disparo com
    // `template_incompleto` — depois de o contato já ter entrado.
    const problemas = problemasParaAtivar("contact_tag_added", { tag: "vip" }, [
      TRIGGER,
      { id: "n2", type: "MESSAGE", label: "Boas-vindas", config: { window_mode: "outside_24h" } },
    ]);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("Boas-vindas");
    expect(problemas[0]).toContain("template aprovado");
  });

  it("fora da janela COM template passa", () => {
    expect(
      problemasParaAtivar("contact_tag_added", { tag: "vip" }, [
        TRIGGER,
        {
          id: "n2",
          type: "MESSAGE",
          label: "",
          config: { window_mode: "outside_24h", template_name: "boas_vindas", template_language: "pt_BR" },
        },
      ]),
    ).toEqual([]);
  });

  it("dentro da janela sem corpo é cobrado, mas só botões passa", () => {
    const semNada = problemasParaAtivar("contact_tag_added", { tag: "vip" }, [
      TRIGGER,
      { id: "n2", type: "MESSAGE", label: "", config: { window_mode: "inside_24h" } },
    ]);
    expect(semNada).toHaveLength(1);

    // Só botões ainda renderiza: eles saem como lista numerada.
    const soBotoes = problemasParaAtivar("contact_tag_added", { tag: "vip" }, [
      TRIGGER,
      { id: "n2", type: "MESSAGE", label: "", config: { window_mode: "inside_24h", buttons: [{ label: "Sim" }] } },
    ]);
    expect(soBotoes).toEqual([]);
  });

  it("o gatilho incompleto continua sendo cobrado", () => {
    const problemas = problemasParaAtivar("contact_tag_added", {}, [TRIGGER, { id: "n2", type: "END", label: "", config: {} }]);
    expect(problemas.join(" ")).toMatch(/gatilho/i);
  });

  it("flow só com o gatilho não liga", () => {
    expect(problemasParaAtivar("contact_tag_added", { tag: "vip" }, [TRIGGER]).join(" ")).toMatch(
      /só tem o gatilho/i,
    );
  });

  it("nó de ação vazio e webhook sem URL são cobrados", () => {
    const problemas = problemasParaAtivar("contact_tag_added", { tag: "vip" }, [
      TRIGGER,
      { id: "n2", type: "ACTION", label: "Ações", config: {} },
      { id: "n3", type: "WEBHOOK", label: "N8N", config: {} },
    ]);
    expect(problemas).toHaveLength(2);
    expect(problemas.join(" ")).toContain("Ações");
    expect(problemas.join(" ")).toContain("N8N");
  });

  it("devolve TODOS os problemas, não o primeiro", () => {
    // Quem liga um flow de doze passos prefere consertar os três de uma vez a
    // descobrir um por tentativa.
    const problemas = problemasParaAtivar("contact_tag_added", {}, [
      TRIGGER,
      { id: "n2", type: "MESSAGE", label: "A", config: { window_mode: "outside_24h" } },
      { id: "n3", type: "MESSAGE", label: "B", config: { window_mode: "inside_24h" } },
    ]);
    expect(problemas.length).toBe(3);
  });
});

describe("o seam do botão: o motor já aceita o que o canal nativo mandaria", () => {
  const config = { buttons: [{ label: "Sim" }, { label: "Não" }, { label: "2" }] };

  it("o ID CANÔNICO da saída casa — é o mesmo de flow_edges.source_handle", () => {
    // É isto que faz o dia do botão nativo não tocar no motor: basta a ingestão
    // gravar `button:<i>` no corpo.
    expect(casarRespostaDeBotao(config, "button:0")).toBe(0);
    expect(casarRespostaDeBotao(config, "button:1")).toBe(1);
  });

  it("id canônico fora do alcance não casa nada, em vez de cair no rótulo", () => {
    expect(casarRespostaDeBotao(config, "button:9")).toBeNull();
  });

  it("o número da lista continua casando, e vence o rótulo ambíguo", () => {
    // O terceiro botão se CHAMA "2". Responder "2" tem de escolher o SEGUNDO
    // (o número da lista), não o que se chama "2".
    expect(casarRespostaDeBotao(config, "2")).toBe(1);
  });

  it("rótulo exato e rótulo contido na frase continuam casando", () => {
    expect(casarRespostaDeBotao(config, "sim")).toBe(0);
    expect(casarRespostaDeBotao(config, "quero dizer que Não")).toBe(1);
  });

  it("nó sem botões nunca casa", () => {
    expect(casarRespostaDeBotao({}, "button:0")).toBeNull();
  });
});

describe("os espaços do template aceitam a chave que o envio espera", () => {
  it("renomear leva o VALOR junto", () => {
    const r = renomearSlot({ "1": "a", "2": "b", "3": "c" }, "2", "header:1");
    expect(r["header:1"]).toBe("b");
    expect(r["1"]).toBe("a");
    expect(r["3"]).toBe("c");
    expect(r["2"]).toBeUndefined();
  });

  it("a ordem das chaves segue a regra do JAVASCRIPT, não a de inserção", () => {
    // Este teste existe porque a versão anterior de `renomearSlot` AFIRMAVA
    // preservar a ordem de inserção, e não preserva: um objeto JS ordena as
    // chaves que parecem índice inteiro primeiro, em ordem numérica, e só
    // depois as demais. Vale para qualquer objeto, inclusive o que vem do
    // jsonb — não é contorno desta função, é a linguagem.
    //
    // O comportamento está pinado aqui para que ninguém volte a prometer o
    // contrário no comentário.
    const r = renomearSlot({ "1": "a", "2": "b", "3": "c" }, "2", "header:1");
    expect(Object.keys(r)).toEqual(["1", "3", "header:1"]);
  });

  it("só posicionais mantêm a ordem numérica, que é o caso comum", () => {
    expect(Object.keys(renomearSlot({ "1": "a", "2": "b" }, "2", "4"))).toEqual(["1", "4"]);
  });

  it("renomear para uma chave existente é ignorado, em vez de colapsar duas", () => {
    const antes = { "1": "a", "2": "b" };
    expect(renomearSlot(antes, "2", "1")).toEqual(antes);
  });

  it("chave vazia é ignorada", () => {
    const antes = { "1": "a" };
    expect(renomearSlot(antes, "1", "   ")).toEqual(antes);
  });

  it("o próximo espaço pula os números já usados", () => {
    expect(proximoSlot({})).toBe("1");
    expect(proximoSlot({ "1": "a", "2": "b" })).toBe("3");
    // Com um slot de cabeçalho no meio, o posicional livre ainda é o 2.
    expect(proximoSlot({ "1": "a", "header:1": "x" })).toBe("2");
  });
});
