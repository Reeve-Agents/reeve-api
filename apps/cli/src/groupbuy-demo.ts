// Beli bareng demo.
//
//   npm run groupbuy:demo            # local Meko (`meko start`), default
//   npm run groupbuy:demo -- --fake  # in-memory Meko, no server needed
//
// Three minimarkets (fixture POs, one supplier S1) consent, approve their own line, one owner refuses
// in round 2 of a second scenario. Code batches and prices; each owner decides in their own workspace;
// the batched order goes through the Log connector (nothing real is sent).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { batchPOs, consentGroupBuy, fixturePOs, GROUP_WORKSPACE, runGroupBuy, verifyGroupOrder, type GroupBuyer, type GroupBuyResult } from "@reeve/crew";
import { connectMeko, FakeMeko, MekoWorkspace, mekoEndpointFromEnv, Pseudonymiser, type MekoTransport } from "@reeve/meko";
import { repoRoot } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";

const args = process.argv.slice(2);
const fake = args.includes("--fake");
const say = (s = "") => console.log(s);
const idr = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

let transport: MekoTransport;
if (fake) transport = new FakeMeko();
else {
  const env = { ...process.env };
  delete env.MEKO_API_KEY; // --local is the default
  if (args.includes("--cloud")) Object.assign(env, process.env);
  else delete env.MEKO_MCP_URL;
  transport = await connectMeko(mekoEndpointFromEnv(env));
}
const home = join(repoRoot, ".reeve", "groupbuy");
mkdirSync(home, { recursive: true });
const ledger = new Ledger(join(home, fake ? "ledger-fake.jsonl" : "ledger.jsonl"));
const tag = Date.now().toString(36); // fresh workspaces per run; nothing is reset
const open = (workspace: string) => MekoWorkspace.open(transport, { workspace, ledger, pseudonyms: new Pseudonymiser() });
const sent: Record<string, unknown>[] = [];
const execute = async (connector: string, tool: string, a: Record<string, unknown>) => {
  sent.push({ connector, tool, ...a });
  return { ok: true, via: "log" };
};

async function scenario(title: string, consent: boolean[], choose: ("approve" | "refuse")[]) {
  say(`\n${title}`);
  const shared = await open(`${GROUP_WORKSPACE}-${tag}`);
  const pos = fixturePOs();
  const wss = await Promise.all(pos.map((p, i) => open(`gb-${p.business}-${tag}`)));
  const buyers: GroupBuyer[] = [];
  for (const [i, po] of pos.entries()) {
    if (consent[i]) await consentGroupBuy(wss[i]!, `M${i + 1}`, { by: "demo owner" });
    buyers.push({ ws: wss[i]!, po, label: `M${i + 1}`, consent: consent[i]!, decide: () => choose[i]! });
  }
  const r: GroupBuyResult = await runGroupBuy(shared, buyers, execute);
  const label = (b: string) => `M${pos.findIndex((p) => p.business === b) + 1}`;
  say("  usaha  qty   total belanja     hemat vs sendiri   receipt");
  for (const q of r.batch.quotes) {
    const rec = r.approvals.find((a) => a.business === q.business)?.receipt ?? "-";
    say(`  ${label(q.business)}     ${String(q.lines.reduce((a, l) => a + l.qty, 0)).padStart(3)}   ${idr(q.total).padStart(14)}   ${idr(q.saving).padStart(14)}     ${rec.slice(0, 10)}`);
  }
  for (const e of r.excluded) say(`  ${label(e.business)}     dikeluarkan (${e.reason === "no_consent" ? "belum izin" : "menolak"})`);
  if (!r.order) say("  tidak ada pesanan: kurang dari 2 persetujuan");
  else {
    const v = await verifyGroupOrder(shared, wss, r.order.receipt);
    say(`  pesanan gabungan S1: ${idr(r.batch.total)}, hemat ${idr(r.batch.saving)}, via ${r.order.exec.via}, receipt ${r.order.receipt.slice(0, 10)}, ronde ${r.rounds}`);
    say(`  verifikasi: ${v.ok ? "OK" : "GAGAL " + v.problems.join("; ")} (${v.approvals} persetujuan)`);
  }
  return r;
}

say("BELI BARENG (fixture PO, tier pemasok S1 = asumsi)");
const solo = batchPOs(fixturePOs());
say(`  tiga PO digabung: ${solo.skus.map((s) => `${s.sku} ${s.qty}${s.discount ? ` (-${s.discount * 100}%)` : ""}`).join(", ")}`);
await scenario("1. Ketiganya setuju", [true, true, true], ["approve", "approve", "approve"]);
await scenario("2. M3 menolak barisnya (harga tier turun, dihitung ulang)", [true, true, true], ["approve", "approve", "refuse"]);
await scenario("3. M3 belum memberi izin", [true, true, false], ["approve", "approve", "approve"]);
say(`\n${sent.length} panggilan Log connector (tidak ada yang dikirim sungguhan).`);
process.exit(0);
