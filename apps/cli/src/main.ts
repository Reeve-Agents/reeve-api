import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSop } from "@reeve/builder";
import type { SimEvent } from "@reeve/core";
import { ProviderRegistry, type LLMProvider } from "@reeve/llm";
import { Ledger, merkleRoot } from "@reeve/receipts";
import { CreateOSSandbox, LocalSandbox, type Sandbox } from "@reeve/sandbox";
import { inferFields } from "@reeve/connectors";
import { bimbelRecords, genericScenario, kosMelatiScenario, loadFixtureRulebook, minimarketScenario, repoRoot, runAttempt, type Attempt } from "@reeve/pipeline";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  lime: (s: string) => `\x1b[38;2;198;255;51m${s}\x1b[0m`,
  violet: (s: string) => `\x1b[38;2;155;100;255m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;2;255;95;95m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;2;110;160;255m${s}\x1b[0m`,
};
const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const section = (label: string, title: string) => console.log(`\n${c.dim(label.padEnd(10))} ${c.bold(title)}`);

function args() {
  const a = process.argv.slice(2);
  const flag = (name: string) => a.find((x) => x.startsWith(`--${name}=`))?.split("=")[1];
  return {
    command: a[0] ?? "demo",
    injectBug: a.includes("--inject-bug"),
    llm: flag("llm") ?? process.env.REEVE_LLM ?? "fixture",
    sandbox: flag("sandbox") ?? process.env.REEVE_SANDBOX ?? "local",
    pack: (flag("pack") ?? "kos-melati") as "kos-melati" | "minimarket" | "bimbel-cerdas",
    sop: flag("sop"),
    home: resolve(repoRoot, process.env.REEVE_HOME ?? ".reeve"),
  };
}

/** --llm takes the same ids as REEVE_LLM: fixture, anthropic, anthropic:claude-haiku-5-5, groq, gemini, ollama, ... */
function pickProvider(kind: string, fixtureDir: string): LLMProvider {
  return ProviderRegistry.fromEnv([loadFixtureRulebook(fixtureDir)], { ...process.env, REEVE_LLM: kind }).get();
}

function pickSandbox(kind: string): Sandbox {
  if (kind === "createos") {
    // Stripe Projects (`stripe projects add createos/project`) writes CREATEOS_PROJECT_API_KEY.
    const key = process.env.CREATEOS_API_KEY ?? process.env.CREATEOS_PROJECT_API_KEY;
    if (!key) throw new Error("--sandbox=createos needs CREATEOS_API_KEY (or CREATEOS_PROJECT_API_KEY from Stripe Projects)");
    return new CreateOSSandbox(key);
  }
  return new LocalSandbox();
}

function printAttempt(a: Attempt) {
  for (const l of a.run.log) console.log(c.dim(`  sandbox │ ${l}`));
  if (!a.results) {
    console.log(c.red(`  job produced no results (exit ${a.run.exitCode})`));
    console.log(c.dim(a.run.stderr.split("\n").slice(-8).join("\n")));
    return;
  }
  const r = a.results;
  console.log(`  builder tests      ${r.builder_tests.ran - r.builder_tests.failed}/${r.builder_tests.ran} passed ${c.dim("(the Builder grading its own work)")}`);
  console.log(`  ${c.violet("auditor spec")}       ${r.audit_spec.ran - r.audit_spec.failed}/${r.audit_spec.ran} cases passed ${c.dim("(derived from the rulebook, not the code)")}`);
  console.log(`  ${c.violet("planted defects")}    ${r.mutation.killed}/${r.mutation.total} caught ${c.dim("(mutation testing)")}`);
  console.log(`  constraints        ${r.constraints.violations.length === 0 ? "no violations" : c.red(`${r.constraints.violations.length} violations`)}`);
  const verdictText = a.verdict.status === "pass" ? c.lime("PASS") : c.red("FAIL");
  console.log(`\n  ${c.violet("Auditor verdict:")} ${verdictText}  ${c.dim(`mutation score ${(a.verdict.mutation_score * 100).toFixed(0)}%`)}`);
  for (const f of a.verdict.findings.filter((f) => f.severity !== "info")) {
    const tag = f.severity === "blocker" ? c.red("blocker") : c.dim("warning");
    console.log(`   ${tag} ${f.code} ${f.message}`);
  }
}

function highlight(events: SimEvent[]) {
  // November cycle only (plus the 1 December credit hand-off), so each line tells one story.
  const pick = (tenant: string, types: SimEvent["type"][]) =>
    events.filter((e) => e.tenant_id === tenant && types.includes(e.type) && e.date <= "2026-12-01");
  const show = (label: string, evs: SimEvent[]) =>
    console.log(`  ${label.padEnd(34)} ${evs.map((e) => `${e.date.slice(5)} ${e.type}${e.amount ? ` ${rp(e.amount)}` : ""}`).join(" · ") || c.dim("none")}`);
  show("K22 new tenant, paid H+9", pick("K22", ["reminder", "late_fee", "payment"]));
  show("K24 veteran, paid H+9 (grace)", pick("K24", ["reminder", "late_fee", "payment"]));
  show("K25 veteran, paid H+12", pick("K25", ["late_fee", "payment"]));
  show("K27 never paid", pick("K27", ["reminder", "late_fee", "notice"]).filter((e) => e.date < "2026-12-01"));
  show("K28 overpaid", pick("K28", ["credit", "payment"]));
  const kpi = events.filter((e) => e.type === "kpi_alert");
  show("KPI (target check on the 15th)", kpi);
}

function highlightStock(events: SimEvent[]) {
  const show = (label: string, types: SimEvent["type"][], max = 4) => {
    const evs = events.filter((e) => types.includes(e.type));
    const text = evs
      .slice(0, max)
      .map((e) => `${e.date.slice(5)} ${e.tenant_id === "-" ? "" : `${e.tenant_id} `}${e.type}${e.note ? ` ${e.note}` : ""}${e.amount ? ` ${rp(e.amount)}` : ""}`)
      .join(" · ");
    console.log(`  ${label.padEnd(30)} ${text || c.dim("none")}${evs.length > max ? c.dim(` (+${evs.length - max})`) : ""}`);
  };
  show("Orders to suppliers", ["po_created"], 3);
  show("Waiting for owner approval", ["po_approval_request"]);
  show("Supplier A late, moved to B", ["supplier_switched"]);
  show("Markdowns before expiry", ["markdown"], 3);
  show("Written off at expiry", ["writeoff"]);
  show("Slow movers stopped", ["reorder_stopped"]);
  show("Expiring-stock alerts (Mondays)", ["kpi_alert"]);
}

async function demo() {
  const opt = args();
  const stock = opt.pack === "minimarket";
  const generic = opt.pack === "bimbel-cerdas";
  const pack = generic ? "generic" : stock ? "minimarket" : "rent-collection";
  const sample = generic ? bimbelRecords() : null;
  const provider = pickProvider(opt.llm, opt.pack);
  const sandbox = pickSandbox(opt.sandbox);
  const sop = readFileSync(opt.sop ?? join(repoRoot, `fixtures/${opt.pack}/sop.md`), "utf8");
  let scenario = stock ? minimarketScenario() : kosMelatiScenario();
  const session = `s${Date.now().toString(36)}`;

  console.log(c.lime(c.bold("\nREEVE")) + c.dim("  your operations, run on your behalf"));
  console.log(c.dim(`llm: ${provider.name} · sandbox: ${sandbox.name} · session ${session}`));

  section("01 DESCRIBE", "Owner's SOP (plain language)");
  console.log(c.dim(sop.trim().split("\n").map((l) => `  ${l}`).join("\n")));

  section("02 COMPILE", "Builder → rule cards");
  // Generic SOPs: the model sees the sheet's field names and types, never its values.
  const parsed = await parseSop(provider, sop, pack, sample ? { fields: inferFields(sample.records) } : undefined);
  if (sample) scenario = genericScenario(parsed.rulebook, sample.records, sample.updates) as never;
  for (const card of parsed.rulebook.cards) {
    const kind = card.kind === "rule" ? c.lime("RULE      ") : card.kind === "constraint" ? c.violet("CONSTRAINT") : c.blue("KPI       ");
    console.log(`  ${card.id.padEnd(3)} ${kind} ${card.title}`);
  }
  if (parsed.issues.length) for (const i of parsed.issues) console.log(c.red(`  ! ${i.card}: ${i.message}`));
  console.log(c.dim(`  ${parsed.rulebook.questions.length} clarifying questions for the owner, e.g. "${parsed.rulebook.questions[0] ?? "-"}"`));

  const ledger = new Ledger(join(opt.home, "ledger.jsonl"));
  const receipts: string[] = [];
  const attempts: Attempt[] = [];
  const bugs = opt.injectBug ? ([generic ? "ignore_never_rules" : stock ? "ignore_markdown_floor" : "ignore_tenure_grace"] as const) : ([] as const);

  for (let n = 1; n <= 2; n++) {
    const useBugs = n === 1 ? [...bugs] : [];
    section(n === 1 ? "03 SIMULATE" : "03 REVISE", n === 1 ? "Builder's code runs in a sandbox; the Auditor tries to break it" : "Builder revises the code from the Auditor's findings and resubmits");
    const attempt = await runAttempt({ repoRoot, rulebook: parsed.rulebook, scenario, sandbox, bugs: useBugs, runId: `${session}-${n}` });
    attempts.push(attempt);
    if (n === 1) {
      const lines = attempt.compiled.files["rules.py"].split("\n");
      const start = lines.findIndex((l) => l.startsWith(generic ? "def _R1_applies" : stock ? "def reorder_due" : "def late_fee_threshold"));
      console.log(c.dim("  rules.py (generated, excerpt):"));
      for (const l of lines.slice(start, start + 7)) console.log(c.dim(`    ${l}`));
    }
    printAttempt(attempt);
    const entry = ledger.append({ kind: "receipt", at: attempt.receipt.created_at, receipt_hash: attempt.receipt.receipt_hash, run_id: attempt.runId, verdict: attempt.verdict.status });
    receipts.push(attempt.receipt.receipt_hash);
    console.log(c.blue(`  receipt ${attempt.receipt.receipt_hash.slice(0, 16)}… → ledger #${entry.seq}`));

    const dir = join(opt.home, "runs", attempt.runId);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(attempt.bundleFiles)) {
      if (!rel.startsWith("job/")) continue;
      const p = join(dir, rel.slice(4));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    writeFileSync(join(dir, "rulebook.json"), JSON.stringify(parsed.rulebook, null, 2));
    writeFileSync(join(dir, "results.json"), JSON.stringify(attempt.results, null, 2));
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(attempt.verdict, null, 2));
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(attempt.receipt, null, 2));

    if (attempt.verdict.status === "pass" || !opt.injectBug) break;
  }

  const final = attempts[attempts.length - 1]!;
  if (final.results && generic) {
    section("04 RESULT", `30 simulated days · ${final.results.simulation.summary.records ?? 0} records from the sheet`);
    const s = final.results.simulation.summary;
    console.log(`  ${s.actions ?? 0} actions · ${s.approval_requests ?? 0} waiting for the owner · ${s.blocked ?? 0} blocked by a never rule · ${s.kpi_alerts ?? 0} KPI alerts`);
    for (const e of final.results.simulation.events.filter((e) => e.type !== "action").slice(0, 6)) console.log(c.dim(`  ${e.date.slice(5)} ${e.type.padEnd(16)} ${e.tenant_id} ${e.tool ?? e.note ?? ""}`));
  } else if (final.results && stock) {
    section("04 RESULT", "30 simulated days · 24 items · two suppliers");
    const s = final.results.simulation.summary;
    console.log(`  sales ${rp(s.sales ?? 0)} · ${s.purchase_orders ?? 0} POs ${rp(s.purchase_value ?? 0)} · ${s.approval_requests ?? 0} waiting for approval · ${s.markdowns ?? 0} markdowns · written off ${rp(s.writeoff_value ?? 0)} · ${s.stockouts ?? 0} stock-outs`);
    highlightStock(final.results.simulation.events);
  } else if (final.results) {
    section("04 RESULT", "60-second view of 45 simulated days (30 rooms)");
    const s = final.results.simulation.summary;
    console.log(`  invoiced ${rp(s.invoiced ?? 0)} · collected ${rp(s.collected ?? 0)} · late fees ${rp(s.fees ?? 0)} · credits ${rp(s.credits ?? 0)} · KPI alerts ${s.kpi_alerts ?? 0}`);
    highlight(final.results.simulation.events);
  }

  section("05 APPROVE", final.verdict.status === "pass" ? "Ready for the owner's passkey" : "Blocked: the owner never sees a failing rulebook for approval");
  console.log(c.dim(final.verdict.status === "pass" ? "  next: owner approves with passkey in the web app → Operator goes live" : "  fix the blockers above and resubmit"));

  section("06 PROVE", "Track record");
  const root = merkleRoot(receipts);
  const anchor = ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: root, leaves: receipts.length, anchor: "local-ledger" });
  const broken = ledger.verify();
  console.log(`  merkle root ${c.blue(root.slice(0, 32))}… over ${receipts.length} receipt(s) → ledger #${anchor.seq}`);
  console.log(`  ledger ${broken === null ? c.lime("intact") : c.red(`broken at #${broken}`)} · ${ledger.entries().length} entries · ${c.dim(join(opt.home, "ledger.jsonl"))}`);
  console.log(c.dim(`  artifacts: ${join(opt.home, "runs")}\n`));

  process.exitCode = final.verdict.status === "pass" ? 0 : 1;
}

const opt = args();
if (opt.command === "demo") {
  demo().catch((err) => {
    console.error(c.red(`\nreeve: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 2;
  });
} else {
  console.log("usage: tsx apps/cli/src/main.ts demo [--pack=kos-melati|minimarket|bimbel-cerdas] [--inject-bug] [--llm=fixture|anthropic] [--sandbox=local|createos] [--sop=path]");
}
