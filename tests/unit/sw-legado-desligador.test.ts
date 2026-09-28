import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * `public/sw.js` é o desligador do SW deixado por um sistema anterior no mesmo
 * domínio (ver o cabeçalho do arquivo). Executa o arquivo REAL num `self`
 * simulado: se ele passar a interceptar fetch, deixar de se desregistrar ou de
 * limpar caches, o domínio volta a servir as telas antigas.
 */
function carregar() {
  const ouvintes: Record<string, (e: unknown) => void> = {};
  const aba = { url: "https://crm.exemplo/app", navigate: vi.fn(async () => aba) };
  const self = {
    addEventListener: (tipo: string, fn: (e: unknown) => void) => {
      ouvintes[tipo] = fn;
    },
    skipWaiting: vi.fn(async () => undefined),
    caches: {
      keys: vi.fn(async () => ["workbox-precache-v2", "paginas-v1"]),
      delete: vi.fn(async (_nome: string) => true),
    },
    registration: { unregister: vi.fn(async () => true) },
    clients: { matchAll: vi.fn(async () => [aba]) },
  };
  const codigo = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  runInNewContext(codigo, { self });
  return { ouvintes, self, aba };
}

describe("public/sw.js — desligador de SW legado", () => {
  it("não intercepta requisição nenhuma", () => {
    const { ouvintes } = carregar();
    expect(Object.keys(ouvintes).sort()).toEqual(["activate", "install"]);
  });

  it("assume na hora, sem esperar as abas antigas fecharem", () => {
    const { ouvintes, self } = carregar();
    ouvintes.install!({});
    expect(self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("ao ativar: apaga os caches, remove o registro e recarrega as abas", async () => {
    const { ouvintes, self, aba } = carregar();
    let trabalho: Promise<unknown> | undefined;
    ouvintes.activate!({ waitUntil: (p: Promise<unknown>) => (trabalho = p) });
    await trabalho;
    expect(self.caches.delete.mock.calls.map((c) => c[0])).toEqual([
      "workbox-precache-v2",
      "paginas-v1",
    ]);
    expect(self.registration.unregister).toHaveBeenCalledOnce();
    expect(self.clients.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(aba.navigate).toHaveBeenCalledWith(aba.url);
  });

  it("nada no produto registra /sw.js — o SW do produto é /notify-sw.js", () => {
    // git grep sai 1 quando não acha nada — é o esperado; 2+ é erro de verdade.
    const r = spawnSync(
      "git",
      ["grep", "-nE", "register\\(\\s*['\"`]/sw\\.js", "--", "app", "components", "lib", "hooks", "workers"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    const achados = r.stdout.trim();
    expect(achados).toBe("");
  });
});
