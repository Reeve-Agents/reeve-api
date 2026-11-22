// Seeds the Meko demo workspace "kos-melati": the real SOP audit (61 planted defects, local
// sandbox), rent ticks with an owner exception, "kenapa saya didenda?", a payment-plan bound,
// Playbook B (kamar kosong) and Playbook C (konten) end to end, then an anchor and the Rapor Usaha.
// Synthetic, pseudonymised data only. No real message is sent (Log connector), the rail is the
// mock or Xendit test mode, and the owner's passkey is marked "demo".
//
//   npm run crew:demo                   # local Meko, templates only (no LLM cost)
//   npm run crew:demo -- --llm          # Worker on Claude Haiku 5.5 (needs ANTHROPIC_API_KEY)
//   npm run crew:demo -- --amend        # also seed repeated owner exceptions and one pending SOP amendment
//                                       # (run the API with REEVE_SOP_AMENDMENTS=on to see it)
//   npm run crew:demo -- --fresh        # drop the demo datapack and ledger first
//   npm run crew:demo -- --ledger=pg    # ledger in Postgres (DATABASE_URL), as the deployed API reads it
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AskBusiness, approveBound, buildRapor, KamarKosong, KontenLoop, KOS_PLAN_BOUND, Ladder, negotiate, newState, playbookB, playbookC, raporHtml, rentTick, saveLadderState, saveReview, storeRapor,
  kosDiscoverySample, parsePaymentsCsv, SopDiscovery,
  amendSampleHistory, loadExceptions, recordException, scanAmendments,
  type ExecResult, type TenantBill, type WorkerFn,
} from "@reeve/crew";
import { filePersistence } from "../../api/src/persistence";
import { AnthropicProvider } from "@reeve/llm";
import { connectMeko, mekoEndpointFromEnv, MekoWorkspace, Pseudonymiser, verifyDecision } from "@reeve/meko";
import { kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, repoRoot, runAttempt } from "@reeve/pipeline";
import { MockRail } from "@reeve/rails";
import { anchorLeaves, Ledger, merkleRoot } from "@reeve/receipts";
import { LocalSandbox } from "@reeve/sandbox";

const args = new Set(process.argv.slice(2));
const WS = process.env.REEVE_MEKO_WORKSPACE ?? "kos-melati";
const home = resolve(repoRoot, process.env.REEVE_HOME ?? ".reeve");
const dir = join(home, "workspaces", `meko-${WS}`);
const say = (s: string) => console.log(s);
const DEMO = { method: "demo" as const, credential_id: "demo-owner" };

const endpoint = mekoEndpointFromEnv();
const meko = await connectMeko(endpoint);
say(`Meko: ${endpoint.cloud ? "Cloud" : "local"} (${endpoint.url})`);

// The deployed API reads the demo ledger from Postgres; a seed for it must write there too.
const pgLedger = args.has("--ledger=pg");
const persistence = pgLedger ? await (await import("../../api/src/pg")).openPostgres(process.env.DATABASE_URL ?? "") : null;
if (pgLedger && !process.env.DATABASE_URL) throw new Error("--ledger=pg needs DATABASE_URL");

if (args.has("--fresh") && persistence) throw new Error("--fresh never deletes a Postgres ledger: use a new REEVE_MEKO_WORKSPACE name instead");
if (args.has("--fresh")) {
  const setup = (await meko.call("conversation_create", { agent_id: "reeve", title: "Reeve reset" })) as { id: string };
  const packs = (await meko.call("datapack_list", { conversation_id: setup.id, limit: 200 })) as { datapack_id: string; datapack_name: string }[];
  for (const p of packs.filter((x) => x.datapack_name === MekoWorkspace.datapackName(WS))) await meko.call("datapack_delete", { conversation_id: setup.id, datapack_id: p.datapack_id });
  rmSync(dir, { recursive: true, force: true });
  say("fresh: demo datapack and ledger removed");
}
mkdirSync(dir, { recursive: true });
// The store holds what the owner web UI reads: the review queue and the autonomy ladder.
const opened = await (persistence ?? filePersistence(home)).openWorkspace(`meko-${WS}`);
const ledger = opened.ledger;
say(`ledger: ${persistence ? `Postgres workspace meko-${WS}` : join(dir, "ledger.jsonl")} (${ledger.entries().length} entries before)`);
const ws = await MekoWorkspace.open(meko, { workspace: WS, ledger, pseudonyms: new Pseudonymiser() });
say(`datapack ${MekoWorkspace.datapackName(WS)} = ${ws.datapackId}`);

const logged: { tool: string; args: Record<string, unknown> }[] = [];
const execute = async (_connector: string, tool: string, a: Record<string, unknown>): Promise<ExecResult> => {
  logged.push({ tool, args: a });
  return { ok: true, via: "log" };
};

let worker: WorkerFn | undefined;
if (args.has("--llm")) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("--llm needs ANTHROPIC_API_KEY in .env");
  const haiku = new AnthropicProvider("claude-haiku-5-5");
  worker = async (system, user) => {
    let usage: { name: string; model: string; input_tokens: number; output_tokens: number } | undefined;
    const text = await haiku.completeText(system, user, { maxTokens: 1200, onUsage: (u) => (usage = { name: "worker_draft", model: u.model, input_tokens: u.inputTokens, output_tokens: u.outputTokens }) });
    return { text, usage };
  };
  say("Worker: Claude Haiku 5.5");
}

// 1. The SOP itself: Builder compiles, Auditor runs every planted defect in the sandbox, owner approves.
const day = "2026-12-01";
const run = ws.run(`run_kos_${day.replaceAll("-", "")}`);
const rulebook = loadFixtureRulebook("kos-melati");
say("auditing the Kos Melati SOP in the local sandbox ...");
const attempt = await runAttempt({ repoRoot, rulebook, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: `meko-${Date.now().toString(36)}` });
const mut = attempt.results?.mutation ?? { killed: 0, total: 0 };
const builder = await run.agent("builder", "Compile SOP: tagihan Kos Melati");
const sop = loadFixtureSop("kos-melati");
await builder.decide({
  input: sop,
  output: { rulebook_hash: attempt.compiled.rulebookHash, cards: rulebook.cards.map((c) => `${c.id} ${c.type}`) },
  reasoning: `Each numbered SOP sentence becomes a rule card; sentence 3 ("H+7 belum lunas kena denda 5% dari harga sewa, cuma sekali per tagihan") is R3 late_fee, sentence 4 adds the 12-month tenure grace of 3 days.`,
  plan: rulebook.cards.map((c) => `${c.id}: ${c.title}`),
  action: "compile",
});
const auditor = await run.agent("auditor", "Audit SOP: tagihan Kos Melati");
const verdictArt = await auditor.artifact("audit-kos-melati.json", { verdict: attempt.verdict, spec_cases: attempt.plan.cases.length, mutation: mut, receipt: attempt.receipt.receipt_hash });
await auditor.decide({
  input: `rules.py ${attempt.compiled.rulebookHash.slice(0, 12)}`,
  output: { status: attempt.verdict.status, spec_cases: attempt.plan.cases.length, planted_defects: `${mut.killed}/${mut.total}`, artifact: verdictArt.content_hash, run_receipt: attempt.receipt.receipt_hash },
  reasoning: `${attempt.plan.cases.length} spec cases written from the rulebook (not the Builder's tests) and ${mut.killed}/${mut.total} planted defects caught in the sandbox, including boundary mutants at H+7, so the rules can go to the owner.`,
  action: attempt.verdict.status === "pass" ? "audit_pass" : "audit_fail",
});
ledger.append({ kind: "receipt", at: new Date().toISOString(), receipt_hash: attempt.receipt.receipt_hash, run_id: attempt.runId, verdict: attempt.verdict.status });
const owner = await run.agent("owner", "Approve SOP: tagihan Kos Melati");
await owner.decide({ input: "approve rulebook kos-melati", output: { approved: true, binds: attempt.receipt.receipt_hash, method: "demo" }, reasoning: "The owner approved with a demo passkey (offline seed); the approval binds the audited run receipt.", action: "approve" });
say(`SOP audit ${attempt.verdict.status}: ${mut.killed}/${mut.total} planted defects, ${attempt.plan.cases.length} spec cases`);

// 2. An owner exception becomes shared memory; rent ticks apply the cards after checking it.
const izin = "Kamar 3 boleh telat sampai 10 hari untuk tagihan Desember 2026, izin pemilik.";
await owner.remember(izin, { kind: "owner_exception", room: "3", until: "2026-12-31" }, { promote: true });
await owner.decide({ input: "Penghuni kamar 3 (K03) minta izin telat bayar Desember", output: { exception: izin, shared: true }, reasoning: "The owner granted a one-month exception; it is promoted to shared memory so the Operator, Builder and WhatsApp replies all see it.", action: "grant_exception", action_class: "exception", subject: "K03" });
const bills: TenantBill[] = [
  { id: "K03", room: "3", due: day, paid: false, tenure_months: 5 },
  { id: "K05", room: "5", due: day, paid: false, tenure_months: 3 },
  { id: "K08", room: "8", due: day, paid: false, tenure_months: 14 },
  { id: "K12", room: "12", due: day, paid: true, tenure_months: 8 },
  { id: "K17", room: "17", due: day, paid: false, tenure_months: 2 },
];
const ladder = new Ladder(ws);
// Earlier in the month 18 more reminders went out by themselves without a complaint: with the ones
// below, "Pengingat bayar" has the 20 clean receipts that let Reeve ask the owner to move it up.
const earlier: TenantBill[] = Array.from({ length: 18 }, (_, i) => ({ id: `K${20 + i}`, room: String(20 + i), due: "2026-11-01", paid: false, tenure_months: 6 }));
await rentTick(run, earlier, "2026-11-04", { execute: (tool, a) => execute("log", tool, a), gate: (cls, unusual) => (cls === "reminder" ? "auto" : ladder.gate(cls, unusual)) });
for (const today of ["2026-12-04", "2026-12-08", "2026-12-11"]) {
  const out = await rentTick(run, bills, today, { execute: (tool, a) => execute("log", tool, a), gate: (cls, unusual) => (cls === "reminder" ? "auto" : ladder.gate(cls, unusual)) });
  say(`tick ${today}: ${out.filter((o) => o.action !== "none").map((o) => `${o.id} ${o.action}`).join(", ")}`);
}

// 3. "Kenapa saya didenda?" on WhatsApp, answered by the read-only agent from the trace.
const ask = new AskBusiness(ws);
const why = await ask.ask("Bu, kenapa saya didenda?", { role: "tenant", subject: "K05" });
const opReply = await run.agent("operator", "WhatsApp: pertanyaan penghuni");
await opReply.decide({ input: "K05: Bu, kenapa saya didenda?", output: { action: "send_explanation", via: "log", answer: why.receipt }, reasoning: "The tenant asked why; the Ask agent's answer (read-only, from the recorded decision) is sent back on the Log connector until WhatsApp is connected.", action: "send_explanation", action_class: "explain_reply", subject: "K05" });
await execute("log", "WHATSAPP_REPLY", { to: "K05", text: why.text });
const hold = await ask.ask("Kenapa kamar 3 boleh telat?", { role: "staff" });
await ask.ask("Siapa yang sering telat bulan ini?", { role: "owner" });
say(`ask: ${why.text.split("\n")[0]}\n     ${hold.text}`);

// 4. One payment-plan bound, approved once, then two requests.
const bill = { subject: "K17", amount: 1_500_000, month: "2026-12" };
await approveBound(run, KOS_PLAN_BOUND, bill, DEMO);
const n1 = await negotiate(run, KOS_PLAN_BOUND, bill, "Bu, saya baru bisa bayar tanggal 20.");
const n2 = await negotiate(run, KOS_PLAN_BOUND, { ...bill, subject: "K08" }, "Bu, boleh bayar tanggal 28?");
say(`cicilan: K17 ${n1.action}, K08 ${n2.action}`);

// 5. Playbook B: kamar kosong terisi sendiri.
const rail = new MockRail();
let clock = Date.parse("2026-12-02T02:00:00Z");
const tick = () => new Date((clock += 7 * 60_000));
const b = new KamarKosong({ ws, execute, rail, worker, gate: ladder.gate, now: tick }, newState(playbookB()), `run_pb_kamar_${Date.now().toString(36)}`);
const bAudit = await b.approveB(DEMO);
say(`playbook B audit ${bAudit.status}: ${bAudit.planted.caught}/${bAudit.planted.total} planted violations, ${bAudit.drafts.caught}/${bAudit.drafts.total} bad drafts`);
// Approving the playbook let its whitelisted CS replies, viewings and in-bound deposits run on usual cases.
const approvalSeq = ws.decisions().find((d) => d.entry_hash === b.state.approved?.receipt)?.seq ?? -1;
say(`autonomy from the approval: ${ladder.grantFromPlaybook(b.state.playbook, approvalSeq).join(", ")} -> ask_if_unusual`);
const listing = await b.roomVacant("7", "3 Desember 2026");
await b.reviewListing(listing.id, { approve: true });
for (const [room, from] of [["9", "10 Desember 2026"], ["11", "12 Desember 2026"]] as const) await b.roomVacant(room, from); // their drafts wait in the owner's review queue
await b.prospectMessage("p1", "Rina Kartika", "7", "Halo kak, harga sewa kamar 7 berapa per bulan?");
await b.prospectMessage("p1", "Rina Kartika", "7", "Fasilitasnya apa aja? ada wifi?");
await b.prospectMessage("p1", "Rina Kartika", "7", "Bisa nego jadi 1,3 juta?");
await b.prospectMessage("p1", "Rina Kartika", "7", "Oke, kapan bisa survei lihat kamar?");
await b.viewingDone("p1", true);
await rail.simulatePayment(b.prospects.p1!.invoice!.id);
const contract = await b.depositPaid("p1");
await b.acceptTenant(contract.id, DEMO);
say(`playbook B: rooms_filled ${b.state.metric}/${b.state.playbook.goal.target}, ${b.state.decisions.length} traced turns`);

// 6. Playbook C: five days of content.
let cday = Date.parse("2026-12-01T01:00:00Z");
const c = new KontenLoop({ ws, execute, rail, worker, now: () => new Date(cday) }, newState(playbookC()), `run_pb_konten_${Date.now().toString(36)}`);
await c.approveC(DEMO);
for (let i = 0; i < 6 && c.state.status === "running"; i++) {
  const plan = await c.plan([{ room: "7", vacant_since: "2026-11-25" }, { room: "21", vacant_since: "2026-11-10" }]);
  const { piece, review } = await c.make(plan);
  await c.review(review.id, true);
  await c.measureAndLearn(piece.id);
  say(`konten ${plan.date}: hook ${plan.hook} -> ${piece.metrics!.wa_inquiries} chats`);
  cday += 86_400_000;
}

// 6b. SOP Discovery: rules mined from a (synthetic) WhatsApp export and payments sheet, every owner
// tap traced, the confirmed rules audited with the planted defects. R8 is declined on purpose.
{
  const sample = kosDiscoverySample();
  const disc = new SopDiscovery(ws);
  const st = await disc.start({ chat: sample.chat, payments: parsePaymentsCsv(sample.payments), business: "Kos Melati" });
  for (const c of st.candidates) await disc.answer(st, c.id, c.id !== "R8", "demo seed");
  const res = await disc.finish(st, async (rb) => {
    const a = await runAttempt({ repoRoot, rulebook: rb, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: `discovery-${Date.now().toString(36)}` });
    return { status: a.verdict.status, cases: a.plan.cases.length, killed: a.results?.mutation.killed ?? 0, total: a.results?.mutation.total ?? 0 };
  });
  say(`discovery: ${st.candidates.length} candidates, replay ${st.replay.agree}/${st.replay.bills}, mode ${res.mode}, audit ${res.audit?.killed}/${res.audit?.total}`);
}

// 6b2. --amend: the owner keeps granting the same exception ("boleh telat sampai 15 hari"), so Reeve
// proposes an SOP amendment, the Auditor tests it with the planted defects, and it waits for the owner.
if (args.has("--amend")) {
  const data = opened.store.data;
  await recordException(ws, data, { rule_id: "R3", reason: izin, subject: "K03", month: "2026-12" });
  for (const [subject, month, days] of [["K03", "2026-08", 12], ["K05", "2026-09", 14], ["K08", "2026-10", 15]] as const)
    await recordException(ws, data, { rule_id: "R3", reason: `Kamar ${Number(subject.slice(1))} boleh telat sampai ${days} hari, izin pemilik.`, subject, month });
  const out = await scanAmendments(ws, data, {
    audit: async (rb) => {
      const a = await runAttempt({ repoRoot, rulebook: rb, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: `amend-${Date.now().toString(36)}` });
      return { status: a.verdict.status, cases: a.plan.cases.length, killed: a.results?.mutation.killed ?? 0, total: a.results?.mutation.total ?? 0 };
    },
    template: () => rulebook,
    history: amendSampleHistory(),
  });
  say(`amend: ${loadExceptions(data).length} exceptions, ${out.shortfalls.length} shortfall(s) [${out.path}]`);
  for (const r of out.results) say(`  ${r.shortfall.rule_id} ${r.shortfall.label} x${r.shortfall.count}: ${r.result.offered ? `offered ${r.result.amendment.id} (${r.result.amendment.audit.killed}/${r.result.amendment.audit.total} defects, ${r.result.amendment.improvement?.summary})` : r.result.reason}`);
}

// 6c. What the owner web UI reads: every crew's queue (only the pending ones stay pending) and the ladder.
saveReview(opened.store.data, [...b.state.queue, ...c.state.queue]);
saveLadderState(opened.store.data, ladder.state);
opened.store.save();
say(`owner state: ${b.state.queue.length + c.state.queue.length} review items (${[...b.state.queue, ...c.state.queue].filter((q) => q.status === "pending").length} pending), ladder ${JSON.stringify(Object.fromEntries(Object.entries(ladder.state.levels).map(([k, v]) => [k, v.level])))}`);

// 7. Anchor the ledger (local; `npm run anchor:now` publishes the root on Monad testnet).
const leaves = anchorLeaves(ledger.entries());
ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "local-ledger" });

// 8. Verify everything, then the Rapor Usaha (stored in Meko as an artifact).
const all = ws.decisions();
let ok = 0;
for (const d of all) if ((await verifyDecision(ws, d.entry_hash)).ok) ok++;
const rapor = await buildRapor(ws);
const stored = await storeRapor(ws, rapor);
writeFileSync(join(dir, "rapor.html"), raporHtml(rapor));
writeFileSync(join(dir, "rapor.json"), JSON.stringify(rapor, null, 2));
const metrics = (await meko.call("datapack_metrics", { conversation_id: ws.setupConversation, datapack_id: ws.datapackId, days: 30 }).catch(() => null)) as { context_efficiency?: { tokens_saved: number; tokens_sent: number; saved_pct: number }; searches?: number } | null;
say(`\n${all.length} traced decisions, ${ok} verified against Meko; ${logged.length} connector calls logged (not sent)`);
say(`rapor artifact ${stored.content_hash.slice(0, 16)}… -> ${join(dir, "rapor.html")}`);
if (metrics?.context_efficiency) say(`context_search: ${metrics.searches} searches, ${metrics.context_efficiency.tokens_sent} tokens sent, ${metrics.context_efficiency.tokens_saved} saved (${metrics.context_efficiency.saved_pct}%)`);
say(`LLM tokens: ${rapor.tokens.llm_input} in / ${rapor.tokens.llm_output} out over ${rapor.tokens.worker_calls} Worker calls`);
await meko.close();
await persistence?.close();
