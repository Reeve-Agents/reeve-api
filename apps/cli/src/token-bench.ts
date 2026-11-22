// Token efficiency benchmark: the same Kos Melati months run two ways.
//
//   BASELINE  "LLM in the loop": per decision, the model gets the full SOP + the whole pseudonymised
//             chat/payments history so far, and decides (strict JSON, plus the message to send).
//   REEVE     the SOP is compiled once (Builder); every decision is made by code (rentTick, with a
//             Meko context_search for the owner's exceptions); the model (Haiku) only words the
//             message, from a small context of the 3 best Meko chunks.
//
//   npm run bench:tokens -- --fake              # offline, deterministic stub + fake counter (NOT a measurement)
//   npm run bench:tokens -- --llm --runs=10     # Claude Haiku 5.5, local Meko (`meko start`); needs ANTHROPIC_API_KEY
//   npm run bench:tokens -- --llm --fake-meko   # real model, in-memory Meko
//
// Caps: estimated spend <= US$2.50, stops if the first baseline run alone costs > US$0.30.
// No prompt caching on either arm. Results: .reeve/bench/tokens-*.json (gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, parseSop } from "@reeve/builder";
import { rentTick, type TenantBill } from "@reeve/crew";
import { AnthropicProvider, CLAUDE_PRICES, costUsd, type LLMUsage } from "@reeve/llm";
import { connectMeko, FakeMeko, MekoWorkspace, mekoEndpointFromEnv, Pseudonymiser, type MekoTransport } from "@reeve/meko";
import { loadFixtureRulebook, repoRoot } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import {
  aggregate, assertPseudonymised, BASELINE_SYSTEM, baselineUser, buildEvents, decideRent, fakeTokens, parseDecision, projectReeve, ratio, sampleHistory, scoreRun,
  type BenchEvent, type Decision, type RunRow,
} from "./token-bench-lib";

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const fake = args.includes("--fake");
const useLlm = args.includes("--llm");
const fakeMeko = fake || args.includes("--fake-meko");
const runs = Math.max(1, Number(flag("runs") ?? 10));
const compiles = Math.max(1, Number(flag("compiles") ?? 3));
const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 1200; // same for both arms (Haiku 5.5 may spend part of it on thinking)
const TOTAL_CAP_USD = 2.5;
const FIRST_BASELINE_STOP_USD = 0.3;
const say = (s = "") => console.log(s);
if (!fake && !useLlm) {
  say("Pass --fake (offline stub, not a measurement) or --llm (real Claude Haiku 5.5, costs money; needs ANTHROPIC_API_KEY).");
  process.exit(1);
}
if (useLlm && !process.env.ANTHROPIC_API_KEY) {
  say("ANTHROPIC_API_KEY is not set (load it with --env-file). Nothing was called.");
  process.exit(1);
}

// ---- model wrapper: one counter for both arms -------------------------------------------------------
interface Call {
  text: string;
  usage: LLMUsage;
}
const anthropic = useLlm ? new AnthropicProvider(MODEL) : null;
const fakeUsage = (input: number, output: number): LLMUsage => ({ provider: `anthropic:${MODEL}`, model: MODEL, inputTokens: input, outputTokens: output, cacheWriteTokens: 0, cacheReadTokens: 0 });
/** Same params both arms: SDK default temperature, no caching, max 1200 tokens. */
async function llm(system: string, user: string, stub: () => string): Promise<Call> {
  if (!anthropic) {
    const text = stub();
    return { text, usage: fakeUsage(fakeTokens(system + user), fakeTokens(text)) };
  }
  assertPseudonymised(system + user);
  let usage: LLMUsage | undefined;
  let text = "";
  try {
    text = await anthropic.completeText(system, user, { maxTokens: MAX_TOKENS, onUsage: (u) => (usage = u) });
  } catch (err) {
    // An unusable reply (e.g. cut off at the token limit) still cost tokens: count them, score the reply as invalid.
    if (!usage) throw err;
    say(`  unusable reply: ${String((err as Error).message).slice(0, 90)}`);
  }
  return { text, usage: usage! };
}
const usd = (u: LLMUsage) => costUsd(u) ?? 0;

// ---- data -------------------------------------------------------------------------------------------
const h = sampleHistory();
const events = buildEvents(h);
const sop = readFileSync(join(repoRoot, "fixtures/kos-melati/sop.md"), "utf8");
const bills = new Set(events.map((e) => `${e.month}${e.subject}`)).size;
const mix = events.reduce<Record<string, number>>((m, e) => ((m[e.expected.action] = (m[e.expected.action] ?? 0) + 1), m), {});
say(`${fake ? "FAKE (offline stub, fake token counter: NOT a measurement)" : `Claude ${MODEL}`}: ${events.length} decision events from ${bills} bills; ground truth ${JSON.stringify(mix)}`);

const home = join(repoRoot, ".reeve", "bench");
mkdirSync(home, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const benchId = Date.now().toString(36);

// ---- Meko workspace (Reeve arm only) ----------------------------------------------------------------
let transport: MekoTransport;
if (fakeMeko) transport = new FakeMeko();
else {
  const env = { ...process.env };
  delete env.MEKO_API_KEY;
  delete env.MEKO_MCP_URL; // local Meko unless the endpoint is set deliberately
  transport = await connectMeko(mekoEndpointFromEnv(env));
}
const ledger = new Ledger(join(home, `ledger-${benchId}.jsonl`));
const wsName = `bench-tokens-${benchId}`;
const ws = await MekoWorkspace.open(transport, { workspace: wsName, ledger, pseudonyms: new Pseudonymiser() });
{
  // Shared memory of the business: the owner's pseudonymised chat lines (the planted exception is one of them).
  const owner = await ws.run("run_bench_seed").agent("owner", "Seed: catatan pemilik");
  const lines = h.events.filter((e) => e.role === "Pemilik");
  for (const e of lines) await owner.remember(e.text, { kind: e.kind, room: e.room ?? "", at: e.at }, { promote: true });
  say(`Meko ${fakeMeko ? "in-memory" : "local"}: workspace ${wsName}, ${lines.length} owner lines seeded as shared memory`);
}

// ---- compile once (Reeve) ---------------------------------------------------------------------------
const compileCalls: { input: number; output: number; usd: number; issues: number; failed_attempts?: number }[] = [];
for (let i = 0; i < compiles; i++) {
  if (anthropic) {
    // A draft the Builder cannot convert (e.g. a card missing a field) is retried, up to 3 attempts; every attempt's tokens count.
    const usage: LLMUsage[] = [];
    let issues = -1;
    let failed = 0;
    for (let attempt = 0; attempt < 3 && issues < 0; attempt++) {
      try {
        const parsed = await parseSop(anthropic, sop, "rent-collection", {}, { onUsage: (u) => usage.push(u) });
        compile(parsed.rulebook);
        issues = parsed.issues.length;
      } catch (err) {
        failed++;
        say(`  compile attempt ${attempt + 1} failed: ${String((err as Error).message).slice(0, 100)}`);
      }
    }
    compileCalls.push({ input: usage.reduce((n, u) => n + u.inputTokens, 0), output: usage.reduce((n, u) => n + u.outputTokens, 0), usd: usage.reduce((n, u) => n + usd(u), 0), issues, failed_attempts: failed });
  } else {
    const rb = loadFixtureRulebook("kos-melati");
    compileCalls.push({ input: fakeTokens(sop) + 900, output: fakeTokens(JSON.stringify(rb)), usd: 0, issues: 0 });
    compileCalls[i]!.usd = usd(fakeUsage(compileCalls[i]!.input, compileCalls[i]!.output));
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const compileCost = { input: mean(compileCalls.map((c) => c.input)), output: mean(compileCalls.map((c) => c.output)), usd: mean(compileCalls.map((c) => c.usd)) };
let spent = compileCalls.reduce((n, c) => n + c.usd, 0);
say(`compile once: mean of ${compiles} Builder call(s) = ${Math.round(compileCost.input)} in / ${Math.round(compileCost.output)} out tokens, $${compileCost.usd.toFixed(4)}`);

// ---- arms -------------------------------------------------------------------------------------------
const stubBaseline = (e: BenchEvent) => () => {
  // Offline stub: a naive reader of the SOP that ignores the 12-month grace and the owner's exception.
  const d = decideRent({ due: e.due, tenure_months: 0, fee_charged: e.fee_charged }, e.today, null);
  return JSON.stringify({ action: d.action === "notice" ? "escalate" : d.action, amount_idr: d.amount_idr ?? null, message: d.action === "none" || d.action === "hold" ? null : "Pengingat sewa (stub)." });
};

async function baselineRun(run: number): Promise<RunRow> {
  const t0 = Date.now();
  let input = 0;
  let output = 0;
  let cost = 0;
  const pairs: { expected: Decision; got: Decision | null }[] = [];
  for (const e of events) {
    const r = await llm(BASELINE_SYSTEM, baselineUser(sop, h, e), stubBaseline(e));
    input += r.usage.inputTokens;
    output += r.usage.outputTokens;
    cost += usd(r.usage);
    pairs.push({ expected: e.expected, got: parseDecision(r.text) });
  }
  return { arm: "baseline", run, calls: events.length, input_tokens: input, output_tokens: output, cost_usd: cost, wall_ms: Date.now() - t0, scored: scoreRun(pairs) };
}

const WORKER_SYSTEM = "Kamu menulis teks pendek untuk usaha kos. Pakai hanya fakta yang diberikan. Jangan menambah harga, klaim, tautan atau nama. Akhiri dengan: (dibuat dengan bantuan AI)"; // as packages/crew/src/crew.ts draft()
const BRIEF = { remind: "Tulis pengingat singkat bahwa sewa belum masuk.", charge_fee: "Tulis pemberitahuan singkat bahwa denda keterlambatan dikenakan.", notice: "Tulis surat peringatan singkat: sudah H+14 belum lunas." } as const;
const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

async function reeveRun(run: number): Promise<RunRow & { searches: number; chunk_tokens: number; worker_calls: number }> {
  const t0 = Date.now();
  let input = 0;
  let output = 0;
  let cost = 0;
  let searches = 0;
  let chunkTokens = 0;
  let workerCalls = 0;
  const pairs: { expected: Decision; got: Decision | null }[] = [];
  const mekoRun = ws.run(`run_bench_${benchId}_r${run}`);
  const worker = await mekoRun.agent("worker", `Bench ${run}: kata-kata pesan`);
  for (const e of events) {
    const bill: TenantBill = { id: e.subject, room: e.room, due: e.due, paid: false, tenure_months: e.tenure_months, fee_charged: e.fee_charged };
    const out = await rentTick(mekoRun, [bill], e.today, { execute: async () => ({ ok: true, via: "log" }) });
    const d = out[0]!;
    pairs.push({ expected: e.expected, got: { action: d.action, ...(d.amount !== undefined ? { amount_idr: d.amount } : {}) } });
    if (d.action === "remind" || d.action === "charge_fee" || d.action === "notice") {
      const found = await worker.search(`${BRIEF[d.action]} kamar ${e.room} sewa denda pengingat`, 3);
      searches++;
      const chunks = [...found.memory.map((m) => m.text), ...found.knowledge.map((k) => k.text)].slice(0, 3).map((t) => `- ${t.slice(0, 240)}`);
      const facts = `Penghuni ${e.subject}, kamar ${e.room}, tagihan jatuh tempo ${e.due}, telat ${d.days_late} hari, sewa ${rp(1_500_000)}${d.amount ? `, denda ${rp(d.amount)}` : ""}.`;
      const user = ws.pseudonyms.redact(`${BRIEF[d.action]}\n\nFakta:\n${facts}\n\nCatatan terkait dari memori bersama:\n${chunks.join("\n")}`);
      chunkTokens += fakeTokens(chunks.join("\n"));
      const r = await llm(WORKER_SYSTEM, user, () => `Halo ${e.subject}, tagihan sewa kamar ${e.room} (stub). (dibuat dengan bantuan AI)`);
      workerCalls++;
      input += r.usage.inputTokens;
      output += r.usage.outputTokens;
      cost += usd(r.usage);
    }
  }
  return { arm: "reeve", run, calls: workerCalls, input_tokens: input, output_tokens: output, cost_usd: cost, wall_ms: Date.now() - t0, scored: scoreRun(pairs), searches, chunk_tokens: chunkTokens, worker_calls: workerCalls };
}

// ---- interleaved runs, with the spend guards --------------------------------------------------------
const rows: RunRow[] = [];
const reeveExtra: { searches: number; chunk_tokens: number; worker_calls: number }[] = [];
let stopped: string | null = null;
const last = { baseline: 0, reeve: 0 };
for (let i = 1; i <= runs && !stopped; i++) {
  for (const arm of (i % 2 ? ["baseline", "reeve"] : ["reeve", "baseline"]) as ("baseline" | "reeve")[]) {
    if (spent + last[arm] > TOTAL_CAP_USD) {
      stopped = `next ${arm} run would pass the US$${TOTAL_CAP_USD} cap (spent $${spent.toFixed(4)})`;
      break;
    }
    const r = arm === "baseline" ? await baselineRun(i) : await reeveRun(i);
    rows.push(r);
    if (arm === "reeve") reeveExtra.push(r as never);
    spent += r.cost_usd;
    last[arm] = r.cost_usd;
    say(`  #${String(i).padStart(2)} ${arm.padEnd(8)} calls ${String(r.calls).padStart(3)}  tokens ${r.input_tokens}/${r.output_tokens}  $${r.cost_usd.toFixed(4)}  ${(r.wall_ms / 1000).toFixed(1)}s  accuracy ${r.scored.accuracy.toFixed(1)}% (${r.scored.correct}/${r.scored.total}, ${r.scored.invalid} invalid)`);
    if (arm === "baseline" && i === 1 && !fake && r.cost_usd > FIRST_BASELINE_STOP_USD) stopped = `first baseline run cost $${r.cost_usd.toFixed(4)} (> $${FIRST_BASELINE_STOP_USD})`;
    if (stopped) break;
  }
}
if (stopped) say(`  STOPPED: ${stopped}`);

// ---- report -----------------------------------------------------------------------------------------
const base = rows.filter((r) => r.arm === "baseline");
const reeve = rows.filter((r) => r.arm === "reeve");
const aB = aggregate(base);
const aR = aggregate(reeve);
const month = { input: aR.input_tokens.mean ?? 0, output: aR.output_tokens.mean ?? 0, usd: aR.cost_usd.mean ?? 0 };
const bMonth = { input: aB.input_tokens.mean ?? 0, output: aB.output_tokens.mean ?? 0, usd: aB.cost_usd.mean ?? 0 };
const proj = [1, 3, 12].map((n) => {
  const p = projectReeve(compileCost, month, n);
  return { ...p, baseline_usd: bMonth.usd * n, baseline_input: bMonth.input * n, baseline_output: bMonth.output * n, cost_ratio_baseline_over_reeve: ratio(bMonth.usd * n, p.usd), input_ratio: ratio(bMonth.input * n, p.input) };
});
const f = (n: number | null, d = 0) => (n === null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const st = (s: { mean: number | null; median: number | null; min: number | null; max: number | null }, d = 0) => `${f(s.mean, d)} / ${f(s.median, d)} / ${f(s.min, d)} / ${f(s.max, d)}`;
const sum = (rs: RunRow[], pick: (r: RunRow) => number) => rs.reduce((n, r) => n + pick(r), 0);
const rByAction = (rs: RunRow[], a: "hold" | "charge_fee") => {
  const c = sum(rs, (r) => r.scored.byAction[a][0]);
  const t = sum(rs, (r) => r.scored.byAction[a][1]);
  return t ? `${f((100 * c) / t, 1)}% (${c}/${t})` : "-";
};
say(`\n${fake ? "FAKE RUN, not a measurement. " : ""}Per run (mean / median / min / max), ${base.length} baseline and ${reeve.length} Reeve runs, ${events.length} decisions each`);
say(`| arm | LLM calls | input tok | output tok | cost USD | accuracy % |`);
say(`|---|---|---|---|---|---|`);
say(`| LLM in the loop | ${st(aB.calls)} | ${st(aB.input_tokens)} | ${st(aB.output_tokens)} | ${st(aB.cost_usd, 4)} | ${st(aB.accuracy, 1)} |`);
say(`| Reeve (code decides, Haiku words) | ${st(aR.calls)} | ${st(aR.input_tokens)} | ${st(aR.output_tokens)} | ${st(aR.cost_usd, 4)} | ${st(aR.accuracy, 1)} |`);
say(`ratio baseline/Reeve (means): calls ${f(ratio(aB.calls.mean ?? 0, aR.calls.mean ?? 0), 2)}x, input ${f(ratio(aB.input_tokens.mean ?? 0, aR.input_tokens.mean ?? 0), 2)}x, output ${f(ratio(aB.output_tokens.mean ?? 0, aR.output_tokens.mean ?? 0), 2)}x, cost ${f(ratio(aB.cost_usd.mean ?? 0, aR.cost_usd.mean ?? 0), 2)}x`);
say(`baseline accuracy on fee decisions ${rByAction(base, "charge_fee")}, on the planted exception (hold) ${rByAction(base, "hold")}; Reeve ${rByAction(reeve, "charge_fee")} / ${rByAction(reeve, "hold")}`);
say(`compile once: ${f(compileCost.input)} in / ${f(compileCost.output)} out, $${compileCost.usd.toFixed(4)} (mean of ${compiles}); per month amortised over 1/3/12 months: ${[1, 3, 12].map((n) => `$${((compileCost.usd + month.usd * n) / n).toFixed(4)}`).join(" / ")}`);
for (const p of proj) say(`extrapolated ${String(p.months).padStart(2)} month(s): Reeve ${f(p.input)} in / ${f(p.output)} out, $${p.usd.toFixed(4)} vs baseline ${f(p.baseline_input)} in / ${f(p.baseline_output)} out, $${p.baseline_usd.toFixed(4)}  (cost ratio ${f(p.cost_ratio_baseline_over_reeve, 2)}x)`);
say(`estimated spend $${spent.toFixed(4)} of $${TOTAL_CAP_USD} cap`);

const file = join(home, `tokens-${stamp}${fake ? "-fake" : ""}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      fake,
      model: fake ? "stub" : MODEL,
      date: new Date().toISOString(),
      price_usd_per_mtok: CLAUDE_PRICES[MODEL]?.standard,
      params: "SDK default temperature, max_tokens 1200, no prompt caching, sequential calls",
      events: events.length,
      bills,
      ground_truth_mix: mix,
      stopped,
      compile: { calls: compileCalls, mean: compileCost },
      aggregate: { baseline: aB, reeve: aR },
      reeve_extra: { searches: aggregate(reeve).calls.mean, per_run: reeveExtra },
      projection_extrapolated: proj,
      spent_usd: spent,
      rows,
    },
    null,
    2,
  ),
);
say(`results: ${file}`);
