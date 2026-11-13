import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "@reeve/builder";
import { Rulebook, type JobResults } from "@reeve/core";
import { countByKind, decide, generateStructuralMutants, prepareAudit } from "../src/index";

const raw = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}/rulebook.json`, import.meta.url)), "utf8"));
const load = (name: string) => Rulebook.parse(raw(name));
const FIXTURES = ["kos-melati", "minimarket", "bimbel-cerdas"];

const results = (total: number, survivors: { id: string; description: string }[]): JobResults => ({
  builder_tests: { ran: 1, failed: 0, failures: [] },
  audit_spec: { ran: 1, failed: 0, failures: [] },
  mutation: { total, killed: total - survivors.length, survivors, inline_sources: true } as JobResults["mutation"],
  constraints: { violations: [] },
  simulation: { events: [], summary: {} },
});

describe("structural planted defects", () => {
  it.each(FIXTURES)("%s: every mutant is valid Python, distinct and differs from the real code", (name) => {
    const rb = load(name);
    const rules = compile(rb).files["rules.py"]!;
    const plan = prepareAudit(rb, rules);
    const dir = mkdtempSync(join(tmpdir(), "reeve-mutants-"));
    try {
      const files = plan.mutants.map((m) => {
        const f = join(dir, `${m.id}.py`);
        writeFileSync(f, m.source);
        return f;
      });
      // A mutant that does not even parse would be "caught" for free; none may exist.
      const r = spawnSync("python3", ["-E", "-s", "-c", "import ast, sys\nfor f in sys.argv[1:]:\n    ast.parse(open(f).read(), f)", ...files], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(new Set(plan.mutants.map((m) => m.source)).size).toBe(plan.mutants.length);
    expect(plan.mutants.some((m) => m.source === rules)).toBe(false);
  });

  it("plants formula, logic and missing-step defects in the rent rules", () => {
    const rb = load("kos-melati");
    const mutants = prepareAudit(rb, compile(rb).files["rules.py"]!).mutants;
    const kinds = countByKind(mutants);
    for (const k of ["boundary", "policy", "formula", "logic", "missing"] as const) expect(kinds[k]).toBeGreaterThan(0);
    const d = mutants.map((m) => m.description);
    expect(d).toContain("late_fee_amount always 0");
    expect(d).toContain("reminder_due never true (step skipped)");
    expect(d.some((x) => x.startsWith("late_fee_amount: * → /"))).toBe(true);
    expect(d.some((x) => x.startsWith("_tenure_months: -= → +="))).toBe(true);
  });

  it("plants safety defects in the generic guards", () => {
    const rb = load("bimbel-cerdas");
    const d = prepareAudit(rb, compile(rb).files["rules.py"]!).mutants.map((m) => m.description);
    expect(d).toContain("needs_approval switched off (always False)");
    expect(d).toContain("blocked switched off (always False)");
    expect(d).toContain("action: amount hidden from the approval limit");
  });

  it("never plants an always-true defect in a rule that already runs every day", () => {
    const rb = load("bimbel-cerdas");
    const d = prepareAudit(rb, compile(rb).files["rules.py"]!).mutants.map((m) => m.description);
    expect(d.filter((x) => /^_R[123]_fires always true$/.test(x))).toEqual([]);
  });

  it("leaves strings and comments alone", () => {
    const src = ['def f(x) -> int:', '    s = "a - b"  # x - y', "    return x - 1", ""].join("\n");
    const formula = generateStructuralMutants(src).filter((m) => m.kind === "formula");
    expect(formula).toHaveLength(1);
    expect(formula[0]!.source).toContain("return x + 1");
    expect(formula[0]!.source).toContain('s = "a - b"  # x - y');
  });
});

describe("verdict", () => {
  const rb = load("kos-melati");
  const plan = prepareAudit(rb, compile(rb).files["rules.py"]!);

  it("blocks approval when a single planted defect survives", () => {
    const v = decide(rb, plan, results(plan.mutants.length, [{ id: "m001", description: plan.mutants[0]!.description }]));
    expect(v.status).toBe("fail");
    expect(v.findings.some((f) => f.code === "MUTANT_SURVIVED" && f.severity === "blocker")).toBe(true);
  });

  it("passes when every planted defect is caught", () => {
    const v = decide(rb, plan, results(plan.mutants.length, []));
    expect(v.status).toBe("pass");
    expect(v.mutation_score).toBe(1);
  });

  it("fails when the sandbox runtime did not read the inline mutant sources", () => {
    // An older runtime cannot find the sources, so every mutant "fails to load" and looks caught.
    const old = results(plan.mutants.length, []);
    const { inline_sources: _, ...mutation } = old.mutation as JobResults["mutation"] & { inline_sources?: boolean };
    const v = decide(rb, plan, { ...old, mutation });
    expect(v.status).toBe("fail");
    expect(v.findings.some((f) => f.code === "JOB_FAILED" && f.severity === "blocker")).toBe(true);
  });
});

describe("unreachable guards", () => {
  it("settles the mutants of a never rule that no record can trigger, and tells the owner", () => {
    const base = raw("bimbel-cerdas");
    const never = base.cards.find((c: { type: string }) => c.type === "generic_never");
    // Every rule already leaves out stopped students, so the "never message stopped students" card cannot fire.
    const cards = base.cards.map((c: { type: string; conditions?: unknown[] }) =>
      c.type === "generic_rule" ? { ...c, conditions: [...(c.conditions ?? []), ...never.conditions.map((n: { value: string }) => ({ ...n, op: "neq" }))] } : c,
    );
    const rb = Rulebook.parse({ ...base, cards });
    const plan = prepareAudit(rb, compile(rb).files["rules.py"]!);
    expect(plan.guards.some((g) => g.message.startsWith(`${never.id}:`))).toBe(true);
    expect(plan.equivalent.some((e) => e.startsWith("_never_1 never true"))).toBe(true);
    expect(plan.mutants.some((m) => m.description === "_never_1 never true (step skipped)")).toBe(false);
  });
});
