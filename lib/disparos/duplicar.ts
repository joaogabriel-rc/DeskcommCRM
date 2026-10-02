/**
 * Duplicar um disparo (migration 0507) — o que a rota precisa saber da config.
 *
 * A imagem de um bloco de mensagem mora em `config.blocks[].media_storage_path`;
 * a busca é recursiva de propósito, para não depender de onde o bloco está
 * (nó novo em `blocks`, ou dentro de outra estrutura que venha a existir).
 */
/** Os caminhos de imagem dos blocos, onde quer que estejam na config. */
export function caminhosDeImagem(config: unknown): string[] {
  const achados: string[] = [];
  const visitar = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visitar);
      return;
    }
    if (v && typeof v === "object") {
      for (const [chave, valor] of Object.entries(v)) {
        if (chave === "media_storage_path" && typeof valor === "string" && valor) achados.push(valor);
        else visitar(valor);
      }
    }
  };
  visitar(config);
  return achados;
}
