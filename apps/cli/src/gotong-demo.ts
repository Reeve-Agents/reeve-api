// Gotong Royong demo and measurement.
//
//   npm run gotong:demo                       # local Meko (`meko start`), offline fixture Builder, 10 runs per arm
//   npm run gotong:demo -- --fake             # in-memory Meko, no server needed
//   npm run gotong:demo -- --runs=12 --llm    # Claude Haiku 5.5 drafts the new business's rulebook (needs ANTHROPIC_API_KEY)
//
// 1. Three businesses (kos-melati, minimarket, bimbel-cerdas) consent; their first drafts (the saved
//    rulebooks of three models) run through the real Builder -> Auditor -> sandbox pipeline.
// 2. Anonymous aggregate patterns (k >= 2, counts and kinds only, leak-checked) go to the shared datapack.
// 3. A NEW business (laundry kiloan) reads the pool, then its Builder drafts WITH and WITHOUT the hints,
//    interleaved, N runs per arm. Per run: first-attempt planted-defect survivors, verdict, tokens.
// With the offline fixture the Builder returns the same rulebook in both arms: that proves the wiring
// (hints reach the Builder's prompt), not an effect. Only --llm can show an effect.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rulebook } from "@reeve/core";
import { parseSop } from "@reeve/builder";
import { inferFields } from "@reeve/connectors";
import { consentReceipt, consentShare, draftRunFromAttempt, extractPatterns, forbiddenTerms, GOTONG_WORKSPACE, publish, readForNewBusiness, type BusinessSource, type DraftRun } from "@reeve/crew";
import { AnthropicProvider, costUsd, packSchema, type LLMProvider, type LLMUsage } from "@reeve/llm";
import { connectMeko, FakeMeko, MekoWorkspace, mekoEndpointFromEnv, Pseudonymiser, type MekoTransport } from "@reeve/meko";
import { genericScenario, kosMelatiScenario, minimarketScenario, repoRoot, runAttempt, bimbelRecords } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { LocalSandbox } from "@reeve/sandbox";
import { parseCsv } from "@reeve/connectors";

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const runsPerArm = Math.max(1, Number(flag("runs") ?? 10));
const useLlm = args.includes("--llm");
const fake = args.includes("--fake");
const MODEL = "claude-haiku-5-5";
const LLM_RUN_CAP = 30;
const COST_PER_RUN_STOP_USD = 0.05;
const say = (s = "") => console.log(s);

const fixDir = join(repoRoot, "apps/cli/fixtures/laundry-kiloan");
const home = join(repoRoot, ".reeve", "gotong");
mkdirSync(home, { recursive: true });

// ---- Meko ---------------------------------------------------------------------------------
let transport: MekoTransport;
if (fake) transport = new FakeMeko();
else {
  const env = { ...process.env };
  delete env.MEKO_API_KEY; // --local is the default: the shared pool lives on local Meko unless MEKO_MCP_URL / --cloud say otherwise
  if (args.includes("--cloud")) Object.assign(env, process.env);
  else delete env.MEKO_MCP_URL;
  transport = await connectMeko(mekoEndpointFromEnv(env));
}
const ledger = new Ledger(join(home, fake ? "ledger-fake.jsonl" : "ledger.jsonl"));
const open = (workspace: string) => MekoWorkspace.open(transport, { workspace, ledger, pseudonyms: new Pseudonymiser() });
const shared = await open(GOTONG_WORKSPACE);

// ---- 1. consent + first drafts of the three businesses ---------------------------------------
const BUSINESSES = [
  { ws: "gotong-kos-melati", dir: "kos-melati", kind: "rent" },
  { ws: "gotong-minimarket", dir: "minimarket", kind: "stock" },
  { ws: "gotong-bimbel", dir: "bimbel-cerdas", kind: "generic" },
] as const;
const VARIANTS = ["rulebook.json", "rulebook.claude-haiku-5-5.json", "rulebook.claude-opus-5-5.json"];
const sandbox = new LocalSandbox();
const sources: BusinessSource[] = [];
const names: string[] = [];
say("01 CONSENT + FIRST DRAFTS (real pipeline, local sandbox)");
for (const b of BUSINESSES) {
  const ws = await open(b.ws);
  if (!consentReceipt(ws, "defect_kinds")) await consentShare(ws, b.dir, ["defect_kinds", "first_draft_findings", "content_hooks"], { by: "demo owner" });
  const drafts: DraftRun[] = [];
  for (const v of VARIANTS) {
    const rb = Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, "fixtures", b.dir, v), "utf8")));
    names.push(rb.business_name);
    const scenario = b.kind === "generic" ? genericScenario(rb, bimbelRecords().records, bimbelRecords().updates) : b.kind === "stock" ? minimarketScenario() : kosMelatiScenario();
    const a = await runAttempt({ repoRoot, rulebook: rb, scenario: scenario as never, sandbox, runId: `gotong-${b.dir}-${v}` });
    drafts.push(draftRunFromAttempt(a));
  }
  sources.push({ ws, drafts });
  say(`  ${b.dir.padEnd(14)} ${drafts.length} first drafts, ${drafts.filter((d) => d.verdict === "pass").length} passed, ${drafts.reduce((n, d) => n + d.survivorKinds.length, 0)} planted-defect survivors`);
}

// ---- 2. patterns -> shared datapack ------------------------------------------------------------
say("\n02 PATTERNS (k >= 2, counts and kinds only)");
const ex = extractPatterns(sources);
const laundryRb = Rulebook.parse(JSON.parse(readFileSync(join(fixDir, "rulebook.json"), "utf8")));
const forbidden = forbiddenTerms(sources, [...names, ...BUSINESSES.map((b) => b.dir), "kos melati", "bimbel cerdas", "laundry"]);
const published = await publish(shared, ex.patterns, { forbidden });
for (const p of ex.patterns) say(`  + ${p.id}  (${p.businesses} businesses)\n    ${p.hint}`);
for (const d of ex.dropped) say(`  - dropped ${d.kind}: ${d.reason}`);
say(`  published ${published.filter((x) => x.receipt).length} new, ${published.filter((x) => x.skipped).length} already in the pool`);

// ---- 3. the new business reads the pool ---------------------------------------------------------
const sop = readFileSync(join(fixDir, "sop.md"), "utf8");
const records = parseCsv(readFileSync(join(fixDir, "data.csv"), "utf8"));
const updates = JSON.parse(readFileSync(join(fixDir, "updates.json"), "utf8"));
const read = await readForNewBusiness(shared, sop);
say(`\n03 NEW BUSINESS READS THE POOL: ${read.hints.length} hint(s), receipt ${read.receipt.slice(0, 16)}...`);
for (const h of read.hints) say(`  - ${h}`);

// ---- 4. experiment -------------------------------------------------------------------------------
class FixtureLaundry implements LLMProvider {
  readonly name = "fixture:laundry";
  async parseSop() {
    return laundryRb;
  }
}
let llmCalls = 0;
const provider: LLMProvider = useLlm ? new AnthropicProvider(MODEL) : new FixtureLaundry();
if (useLlm && !process.env.ANTHROPIC_API_KEY) {
  say("ANTHROPIC_API_KEY is not set (load it with --env-file). Nothing was called.");
  process.exit(1);
}
const fields = inferFields(records);
const promptChars = (hints?: string[]) => packSchema("generic", { fields, ...(hints?.length ? { sharedHints: hints } : {}) }).system.length;

interface RunRow {
  arm: "with_hints" | "without_hints";
  index: number;
  parsed: boolean;
  error?: string;
  verdict?: "pass" | "fail";
  mutation_total?: number;
  mutation_killed?: number;
  survivors?: number;
  blockers: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  system_prompt_chars: number;
}

async function oneRun(arm: RunRow["arm"], index: number): Promise<RunRow> {
  const hints = arm === "with_hints" ? read.hints : undefined;
  const usage: LLMUsage[] = [];
  const row: RunRow = { arm, index, parsed: false, blockers: [], input_tokens: 0, output_tokens: 0, cost_usd: 0, system_prompt_chars: promptChars(hints) };
  try {
    if (useLlm) llmCalls++;
    // The SOP and the field names are what the model sees; this SOP names no person, and any real one would pass through the workspace's pseudonymiser first.
    const parsed = await parseSop(provider, shared.pseudonyms.redact(sop), "generic", { fields }, { onUsage: (u) => usage.push(u), sharedHints: hints });
    row.parsed = true;
    const a = await runAttempt({ repoRoot, rulebook: parsed.rulebook, scenario: genericScenario(parsed.rulebook, records, updates) as never, sandbox, runId: `gotong-laundry-${arm}-${index}` });
    const d = draftRunFromAttempt(a);
    Object.assign(row, { verdict: d.verdict, mutation_total: d.mutation.total, mutation_killed: d.mutation.killed, survivors: d.survivorKinds.length, blockers: d.blockers.map((b) => `${b.code}: ${b.message}`.slice(0, 160)) });
  } catch (err) {
    row.error = String((err as Error).message ?? err).slice(0, 200);
  }
  row.input_tokens = usage.reduce((n, u) => n + u.inputTokens, 0);
  row.output_tokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  const costs = usage.map((u) => costUsd(u));
  row.cost_usd = costs.some((c) => c === null) ? null : costs.reduce((n: number, c) => n + (c ?? 0), 0);
  return row;
}

say(`\n04 EXPERIMENT: laundry kiloan, ${runsPerArm} runs per arm, ${useLlm ? `Claude ${MODEL}` : "offline fixture Builder (same rulebook in both arms)"}, interleaved`);
if (useLlm && runsPerArm * 2 > LLM_RUN_CAP) {
  say(`refused: ${runsPerArm * 2} LLM runs exceed the cap of ${LLM_RUN_CAP}`);
  process.exit(1);
}
const rows: RunRow[] = [];
let stopped: string | null = null;
for (let i = 1; i <= runsPerArm && !stopped; i++) {
  for (const arm of (i % 2 ? ["without_hints", "with_hints"] : ["with_hints", "without_hints"]) as RunRow["arm"][]) {
    const r = await oneRun(arm, i);
    rows.push(r);
    say(`  #${String(i).padStart(2)} ${arm.padEnd(13)} ${r.error ? `error: ${r.error.slice(0, 80)}` : `${r.verdict} survivors=${r.survivors} killed=${r.mutation_killed}/${r.mutation_total}`}  tokens ${r.input_tokens}/${r.output_tokens}  ${r.cost_usd === null ? "cost ?" : `$${r.cost_usd.toFixed(4)}`}`);
    if (useLlm && (r.cost_usd ?? 0) > COST_PER_RUN_STOP_USD) stopped = `a run cost $${r.cost_usd?.toFixed(4)} (> $${COST_PER_RUN_STOP_USD})`;
    if (llmCalls >= LLM_RUN_CAP) stopped = `LLM run cap ${LLM_RUN_CAP} reached`;
    if (stopped) break;
  }
}
if (stopped) say(`  STOPPED: ${stopped}`);

// ---- 5. stats ---------------------------------------------------------------------------------------
const stat = (xs: number[]) => {
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, median: s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, min: s[0]!, max: s.at(-1)! };
};
const arms = ["without_hints", "with_hints"] as const;
const summary = Object.fromEntries(
  arms.map((arm) => {
    const r = rows.filter((x) => x.arm === arm);
    const ok = r.filter((x) => x.parsed);
    return [
      arm,
      {
        runs: r.length,
        parsed: ok.length,
        first_draft_pass: r.filter((x) => x.verdict === "pass").length,
        first_draft_survivors: stat(ok.map((x) => x.survivors ?? 0)),
        blockers_per_draft: stat(ok.map((x) => x.blockers.length)),
        input_tokens: stat(r.map((x) => x.input_tokens)),
        output_tokens: stat(r.map((x) => x.output_tokens)),
        cost_usd: stat(r.flatMap((x) => (x.cost_usd === null ? [] : [x.cost_usd]))),
        system_prompt_chars: r[0]?.system_prompt_chars ?? 0,
      },
    ];
  }),
);
const f = (n: number | null, d = 2) => (n === null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(d));
const line = (label: string, get: (a: (typeof summary)[string]) => string) => say(`  ${label.padEnd(30)}${arms.map((a) => get(summary[a]!).padEnd(26)).join("")}`);
say(`\n05 RESULT\n  ${"".padEnd(30)}${arms.map((a) => a.padEnd(26)).join("")}`);
line("runs / parsed", (a) => `${a.runs} / ${a.parsed}`);
line("first draft passed", (a) => `${a.first_draft_pass} of ${a.runs}`);
line("survivors  mean/med/min/max", (a) => `${f(a.first_draft_survivors.mean)}/${f(a.first_draft_survivors.median)}/${f(a.first_draft_survivors.min)}/${f(a.first_draft_survivors.max)}`);
line("blockers   mean/med/min/max", (a) => `${f(a.blockers_per_draft.mean)}/${f(a.blockers_per_draft.median)}/${f(a.blockers_per_draft.min)}/${f(a.blockers_per_draft.max)}`);
line("input tok  mean/med/min/max", (a) => `${f(a.input_tokens.mean, 0)}/${f(a.input_tokens.median, 0)}/${f(a.input_tokens.min, 0)}/${f(a.input_tokens.max, 0)}`);
line("output tok mean/med/min/max", (a) => `${f(a.output_tokens.mean, 0)}/${f(a.output_tokens.median, 0)}/${f(a.output_tokens.min, 0)}/${f(a.output_tokens.max, 0)}`);
line("cost USD per run (mean)", (a) => (a.cost_usd.mean === null ? "-" : a.cost_usd.mean.toFixed(5)));
line("system prompt chars", (a) => String(a.system_prompt_chars));
const blockerCounts = new Map<string, number>();
for (const r of rows) for (const b of r.blockers) blockerCounts.set(`${r.arm}: ${b.slice(0, 110)}`, (blockerCounts.get(`${r.arm}: ${b.slice(0, 110)}`) ?? 0) + 1);
for (const [k, n] of blockerCounts) say(`  blocker x${n}  ${k}`);

const out = {
  generated_at: new Date().toISOString(),
  mode: useLlm ? `llm:${MODEL}` : "fixture (deterministic, same rulebook in both arms)",
  meko: fake ? "in-memory" : mekoEndpointFromEnv(args.includes("--cloud") ? process.env : { ...process.env, MEKO_API_KEY: undefined, MEKO_MCP_URL: undefined }).url,
  shared_datapack: MekoWorkspace.datapackName(GOTONG_WORKSPACE),
  runs_per_arm: runsPerArm,
  llm_calls: llmCalls,
  stopped,
  patterns: ex.patterns.map((p) => ({ id: p.id, kind: p.kind, businesses: p.businesses, counts: p.counts, hint: p.hint })),
  dropped: ex.dropped,
  hints_read: read.hints,
  read_receipt: read.receipt,
  summary,
  rows,
};
const file = join(home, `results-${useLlm ? "llm" : "fixture"}-${Date.now().toString(36)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
say(`\nresults: ${file}`);
await transport.close();
