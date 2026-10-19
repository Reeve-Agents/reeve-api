import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, prepareAudit, type AuditPlan } from "@reeve/auditor";
import { compile, type CompiledSop, type InjectedBug } from "@reeve/builder";
import type { AnyScenario, JobResults, Receipt, Rulebook, SimEvent, Verdict } from "@reeve/core";
import { buildReceipt } from "@reeve/receipts";
import type { JobRun, Sandbox } from "@reeve/sandbox";

export interface Attempt {
  runId: string;
  compiled: CompiledSop;
  plan: AuditPlan;
  run: JobRun;
  results: JobResults | null;
  verdict: Verdict;
  receipt: Receipt;
  bundleFiles: Record<string, string>;
}

/** Ship the Python runtime as part of every job, so the sandbox needs nothing pre-installed. */
export function runtimeFiles(repoRoot: string): Record<string, string> {
  const dir = join(repoRoot, "runtime", "reeve_runtime");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".py")) files[`reeve_runtime/${f}`] = readFileSync(join(dir, f), "utf8");
  return files;
}

/** Compile → audit → run everything in ONE sandbox → verdict → receipt. */
export async function runAttempt(opts: {
  repoRoot: string;
  rulebook: Rulebook;
  scenario: AnyScenario;
  sandbox: Sandbox;
  bugs?: InjectedBug[];
  runId: string;
  /** Live glass-box lines (sandbox lifecycle, exec). */
  onLog?: (line: string) => void;
}): Promise<Attempt> {
  const compiled = compile(opts.rulebook, { bugs: opts.bugs });
  const plan = prepareAudit(opts.rulebook, compiled.files["rules.py"]);

  const jobFiles: Record<string, string> = {
    "rules.py": compiled.files["rules.py"],
    "test_builder.py": compiled.files["test_builder.py"],
    "scenario.json": JSON.stringify(opts.scenario, null, 2),
    ...plan.files,
  };
  const bundleFiles: Record<string, string> = { ...runtimeFiles(opts.repoRoot) };
  for (const [k, v] of Object.entries(jobFiles)) bundleFiles[`job/${k}`] = v;

  opts.onLog?.(`compiled rules.py (${compiled.files["rules.py"].split("\n").length} lines) from rulebook ${compiled.rulebookHash.slice(0, 12)}`);
  opts.onLog?.(`auditor prepared ${plan.cases.length} spec cases and ${plan.mutants.length} planted defects`);
  const run = await opts.sandbox.runJob(
    {
      files: bundleFiles,
      command: ["python3", "-E", "-s", "-m", "reeve_runtime.job", "job"],
      resultPath: "job/results.json",
    },
    opts.onLog,
  );

  let results: JobResults | null = null;
  if (run.result) {
    try {
      results = JSON.parse(run.result) as JobResults;
    } catch {
      results = null;
    }
  }
  const verdict = decide(opts.rulebook, plan, results);
  const receipt = buildReceipt({
    runId: opts.runId,
    rulebook: opts.rulebook,
    code: { "rules.py": compiled.files["rules.py"], "test_builder.py": compiled.files["test_builder.py"], "audit_cases.json": plan.files["audit_cases.json"]! },
    data: opts.scenario,
    results: results ?? { error: run.stderr.slice(-2000) },
    verdict: verdict.status,
  });
  return { runId: opts.runId, compiled, plan, run, results, verdict, receipt, bundleFiles };
}

export interface OperateResult {
  events: SimEvent[];
  violations: string[];
  run: JobRun;
}

/**
 * The Operator's job: the approved rules.py, unchanged, over real tenants and real payments up to
 * Reeve's business clock. Same sandbox, no keys: the broker turns the new events into rail calls.
 */
export async function runOperate(opts: {
  repoRoot: string;
  rulesPy: string;
  constraintsJson: string;
  scenario: AnyScenario;
  sandbox: Sandbox;
  onLog?: (line: string) => void;
}): Promise<OperateResult> {
  const files: Record<string, string> = {
    ...runtimeFiles(opts.repoRoot),
    "job/rules.py": opts.rulesPy,
    "job/scenario.json": JSON.stringify(opts.scenario, null, 2),
    "job/constraints.json": opts.constraintsJson,
  };
  const run = await opts.sandbox.runJob(
    { files, command: ["python3", "-E", "-s", "-m", "reeve_runtime.operate", "job"], resultPath: "job/operate.json" },
    opts.onLog,
  );
  if (!run.result) throw new Error(`operator job produced no result (exit ${run.exitCode}): ${run.stderr.split("\n").slice(-4).join(" ")}`);
  const parsed = JSON.parse(run.result) as { events: SimEvent[]; violations: string[] };
  return { events: parsed.events, violations: parsed.violations, run };
}
