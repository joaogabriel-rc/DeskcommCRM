// Prova do ataque direto ao PostgREST da stack de prova LOCAL, com o JWT do
// próprio usuário de teste. Não imprime chave nem token.
// Uso: node ataque-postgrest.mjs <prova.env>
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(process.argv[2], "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"(.*)"$/, "$1")]),
);
const base = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) throw new Error("só roda contra a stack local");
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anon, "content-type": "application/json" },
  body: JSON.stringify({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD }),
});
const { access_token } = await login.json();
console.log(`login da conta de teste (admin da org): HTTP ${login.status}`);
const h = { apikey: anon, authorization: `Bearer ${access_token}`, "content-type": "application/json", prefer: "return=representation" };

const ler = async (wamid) => {
  const r = await fetch(`${base}/rest/v1/messages?external_id=eq.${wamid}&select=external_id,direction,body,status,revoked_at`, { headers: h });
  return (await r.json())[0];
};

const tentativas = [
  ["reescrever o texto da recebida viva", "wamid.apg1.viva", { body: "ADULTERADO PELO POSTGREST" }],
  ["desfazer o apagamento da recebida e devolver texto", "wamid.apg1.txt", { revoked_at: null, body: "RESTAURADO" }],
  ["marcar a enviada como lida e trocar o autor", "wamid.apg1.eco", { status: "read", sent_by_user_id: null }],
];
for (const [nome, wamid, patch] of tentativas) {
  const antes = await ler(wamid);
  const r = await fetch(`${base}/rest/v1/messages?external_id=eq.${wamid}`, { method: "PATCH", headers: h, body: JSON.stringify(patch) });
  const corpo = await r.text();
  const depois = await ler(wamid);
  const mudou = JSON.stringify(antes) !== JSON.stringify(depois);
  console.log(`${nome}: HTTP ${r.status} ${corpo.slice(0, 110)} | linha mudou? ${mudou ? "SIM" : "não"}`);
}
const leitura = await fetch(`${base}/rest/v1/messages?select=id&limit=1`, { headers: h });
console.log(`CONTROLE leitura pelo PostgREST: HTTP ${leitura.status}, ${(await leitura.json()).length} linha(s)`);
