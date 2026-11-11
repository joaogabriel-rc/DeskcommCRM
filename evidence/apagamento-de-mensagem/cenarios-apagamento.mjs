// Prova visual do apagamento: entregas no formato da Meta, ASSINADAS com o segredo
// de teste, para a rota universal do app LOCAL. Só fala com localhost.
// Uso: node cenarios-apagamento.mjs <prova.env> <fase: base|apagar> <prefixo>
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(process.argv[2], "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"(.*)"$/, "$1")]),
);
const fase = process.argv[3];
const P = process.argv[4];
const URL = "http://localhost:3210/api/v1/webhooks/meta";
const NUM = "900000000000001";
const WABA = "910000000000001";
const CLIENTE = "5562988887777";
const t0 = process.env.T0 ? Number(process.env.T0) : Math.floor(Date.now() / 1000) - 300;
const ts = (s) => String(t0 + s);
const meta = { display_phone_number: "5562900000001", phone_number_id: NUM };
const recebidas = (...messages) => ({
  id: WABA,
  changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta, contacts: [{ wa_id: CLIENTE, profile: { name: "Cliente Prova" } }], messages } }],
});
const ecos = (...message_echoes) => ({
  id: WABA,
  changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: meta, message_echoes } }],
});

const fases = {
  base: [
    recebidas({ from: CLIENTE, id: `wamid.${P}.viva`, timestamp: ts(10), type: "text", text: { body: "Controle: esta mensagem NÃO foi apagada" } }),
    ecos({ from: "5562900000001", to: CLIENTE, id: `wamid.${P}.eco`, timestamp: ts(20), type: "text", text: { body: "EMPRESA-APAGOU: desconto de 30% só hoje" } }),
    recebidas({ from: CLIENTE, id: `wamid.${P}.img`, timestamp: ts(30), type: "image", image: { id: `MID-${P}`, mime_type: "image/jpeg", caption: "SEGREDO-NA-LEGENDA: foto do meu documento" } }),
    recebidas({ from: CLIENTE, id: `wamid.${P}.txt`, timestamp: ts(40), type: "text", text: { body: "SEGREDO-APAGADO: meu CPF é 000.000.000-00" } }),
  ],
  apagar: [
    recebidas({ from: CLIENTE, id: `wamid.${P}.rv.txt`, timestamp: ts(60), type: "revoke", revoke: { original_message_id: `wamid.${P}.txt` } }),
    recebidas({ from: CLIENTE, id: `wamid.${P}.rv.img`, timestamp: ts(70), type: "revoke", revoke: { original_message_id: `wamid.${P}.img` } }),
    ecos({ from: "5562900000001", to: CLIENTE, id: `wamid.${P}.rv.eco`, timestamp: ts(80), type: "revoke", revoke: { original_message_id: `wamid.${P}.eco` } }),
  ],
};

for (const entry of fases[fase]) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [entry] });
  const assinatura = "sha256=" + createHmac("sha256", env.META_APP_SECRET).update(corpo, "utf8").digest("hex");
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinatura }, body: corpo });
  const v = entry.changes[0].value;
  const item = v.messages?.[0] ?? v.message_echoes?.[0];
  console.log(`${fase} | ${item.id} (${item.type}) -> HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
}
