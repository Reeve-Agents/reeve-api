/**
 * Structural planted defects: mistakes in the logic itself, on top of the boundary and policy
 * mutants each pack plants. Every mutant is a one-line change to the Builder's rules.py that still
 * compiles, so the spec has to notice it by behaviour, never by a crash on import.
 *
 *   formula   an arithmetic operator swapped (+ ↔ -, * ↔ /, += ↔ -=) or a unary minus dropped
 *   logic     an `if` or a yes/no answer turned around, `and` ↔ `or`, a rule that always fires
 *   missing   a step that never happens: a yes/no rule that always answers no, an amount that is always 0
 *   safety    an approval or "never" guard switched off, or the amount hidden from the approval check
 */
import type { Mutant, MutantKind } from "./mutate";

export interface StructuralOptions {
  /** Function names left alone: shared helpers and dispatch glue that carry no rule of their own. */
  skipFunctions?: Iterable<string>;
  /** Extra per-line filter, e.g. code that is dead under the rulebook's chosen policy. */
  skipLine?: (fn: string, line: string, bodyLines: string[]) => boolean;
}

interface Fn {
  name: string;
  returns: string | null;
  /** Index of the first body line and of the last non-blank body line. */
  start: number;
  end: number;
  indent: string;
}

const DEFAULT_SKIP = ["_num", "_text", "_until", "_render", "fires", "applies", "once", "kpi_fires", "kpi_value", "kpi_alert", "default_supplier", "backup_supplier"];
/** Guards whose job is to stop money or messages: switching them off is a safety defect. */
const SAFETY_FUNCS = new Set(["needs_approval", "po_needs_approval", "blocked"]);
/** Generated yes/no helpers of the generic pack that carry no return annotation. */
const PREDICATE = /^_R\d+_(applies|counts|alert|fires)$|^_never_\d+$/;
/** Generated number helpers of the generic pack that carry no return annotation. */
const NUMBER_FN = /^_R\d+_value$/;
const AOR: Record<string, string> = { "+": "-", "-": "+", "*": "/", "/": "*" };

function functions(lines: string[]): Fn[] {
  const out: Fn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^def (\w+)\(.*\)\s*(?:->\s*([^:]+?))?\s*:\s*$/);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;
    let last = end - 1;
    while (last > i && lines[last]!.trim() === "") last--;
    if (last <= i) continue;
    const first = lines.slice(i + 1, last + 1).find((l) => l.trim() !== "")!;
    out.push({ name: m[1]!, returns: m[2]?.trim() ?? null, start: i + 1, end: last, indent: first.match(/^\s*/)![0] });
  }
  return out;
}

/** true where `line` is code: outside string literals and comments. */
function codeMask(line: string): boolean[] {
  const mask = new Array<boolean>(line.length).fill(true);
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      mask[i] = false;
      if (c === "\\" && i + 1 < line.length) mask[++i] = false;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "#") {
      for (let j = i; j < line.length; j++) mask[j] = false;
      break;
    }
    if (c === '"' || c === "'") {
      quote = c;
      mask[i] = false;
    }
  }
  return mask;
}

/** Code positions where `re` (global) matches, using the index of capture group 1 when present. */
function codeMatches(line: string, re: RegExp): { at: number; text: string }[] {
  const mask = codeMask(line);
  const out: { at: number; text: string }[] = [];
  for (const m of line.matchAll(re)) {
    const at = m.index! + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
    const text = m[1] ?? m[0];
    if (mask[at]) out.push({ at, text });
  }
  return out;
}

const splice = (line: string, at: number, len: number, rep: string) => line.slice(0, at) + rep + line.slice(at + len);
const snippet = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};
/** The code around one position, so two changes on the same line read differently. */
const around = (line: string, at: number, len: number) => {
  const a = Math.max(0, at - 26);
  const b = Math.min(line.length, at + len + 26);
  return `${a > 0 ? "…" : ""}${line.slice(a, b).trim()}${b < line.length ? "…" : ""}`;
};

const isBool = (f: Fn) => f.returns === "bool" || PREDICATE.test(f.name) || SAFETY_FUNCS.has(f.name);
const isNumber = (f: Fn) => f.returns === "int" || f.returns === "float" || NUMBER_FN.test(f.name);

/** A unary minus: the token before it is an operator, a keyword or an opening bracket. */
function unaryMinusAt(line: string, at: number): boolean {
  if (!/[A-Za-z_(]/.test(line[at + 1] ?? "")) return false;
  const before = line.slice(0, at).trimEnd();
  if (before === "" || /[(\[,=<>+\-*/:]$/.test(before)) return true;
  return /\b(and|or|not|return|in|if|elif|else)$/.test(before);
}

export function generateStructuralMutants(rulesPy: string, opts: StructuralOptions = {}): Omit<Mutant, "id">[] {
  const lines = rulesPy.split("\n");
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipFunctions ?? [])]);
  const out: Omit<Mutant, "id">[] = [];
  const seen = new Set<string>([rulesPy]);
  const add = (kind: MutantKind, description: string, next: string[]) => {
    const source = next.join("\n");
    if (seen.has(source)) return;
    seen.add(source);
    out.push({ kind, description, source });
  };
  const replaceLine = (i: number, text: string) => lines.map((l, j) => (j === i ? text : l));
  const insertAt = (i: number, text: string) => [...lines.slice(0, i), text, ...lines.slice(i)];

  for (const f of functions(lines)) {
    if (skip.has(f.name)) continue;
    const body = lines.slice(f.start, f.end + 1);
    const safety = SAFETY_FUNCS.has(f.name);

    // Whole-function defects: the step never happens, or always happens. A body that already is
    // `return True` (a rule that runs every day) would only yield an equivalent mutant.
    const only = body.filter((l) => l.trim() !== "").map((l) => l.trim());
    const constant = only.length === 1 ? only[0] : null;
    if (isBool(f)) {
      if (constant !== "return False") {
        add(safety ? "safety" : "missing", safety ? `${f.name} switched off (always False)` : `${f.name} never true (step skipped)`, insertAt(f.start, `${f.indent}return False`));
      }
      if (constant !== "return True") add("logic", `${f.name} always true`, insertAt(f.start, `${f.indent}return True`));
    } else if (isNumber(f) && constant !== "return 0") {
      add("missing", `${f.name} always 0`, insertAt(f.start, `${f.indent}return 0`));
    }

    for (let i = f.start; i <= f.end; i++) {
      const line = lines[i]!;
      if (line.trim() === "" || line.trim().startsWith("#") || line.includes('"""')) continue;
      if (opts.skipLine?.(f.name, line, body)) continue;

      // formula: arithmetic operator replacement, augmented assignment, unary minus
      for (const m of codeMatches(line, /(?<= )([+\-*/])(?= )/g)) {
        const rep = AOR[m.text]!;
        add("formula", `${f.name}: ${m.text} → ${rep} in "${around(line, m.at, 1)}"`, replaceLine(i, splice(line, m.at, 1, rep)));
      }
      for (const m of codeMatches(line, /(?<= )([+-])=(?= )/g)) {
        const rep = m.text === "+" ? "-" : "+";
        add("formula", `${f.name}: ${m.text}= → ${rep}= in "${around(line, m.at, 2)}"`, replaceLine(i, splice(line, m.at, 1, rep)));
      }
      for (const m of codeMatches(line, /(-)/g)) {
        if (!unaryMinusAt(line, m.at)) continue;
        add("formula", `${f.name}: minus sign dropped in "${around(line, m.at, 1)}"`, replaceLine(i, splice(line, m.at, 1, "")));
      }

      // logic: and ↔ or
      for (const m of codeMatches(line, /\b(and|or)\b/g)) {
        const rep = m.text === "and" ? "or" : "and";
        add("logic", `${f.name}: ${m.text} → ${rep} in "${around(line, m.at, m.text.length)}"`, replaceLine(i, splice(line, m.at, m.text.length, rep)));
      }

      // logic: an if/elif condition turned around
      const cond = line.match(/^(\s*)(if|elif) (.+):\s*$/);
      if (cond) add("logic", `${f.name}: condition inverted in "${snippet(line)}"`, replaceLine(i, `${cond[1]}${cond[2]} not (${cond[3]}):`));

      // logic: a yes/no answer turned around
      const ret = line.match(/^(\s*)return (.+)$/);
      if (ret && isBool(f) && !/^(True|False)$/.test(ret[2]!.trim())) {
        const expr = ret[2]!.trim();
        const next = expr === "(" ? `${ret[1]}return not (` : `${ret[1]}return not (${expr})`;
        add(safety ? "safety" : "logic", `${f.name}: answer inverted in "${snippet(line)}"`, replaceLine(i, next));
      }

      // safety: the amount never reaches the approval check
      const amount = line.match(/^(\s*)amount = (.+)$/);
      if (amount && f.name === "action" && amount[2]!.trim() !== "None") {
        add("safety", "action: amount hidden from the approval limit", replaceLine(i, `${amount[1]}amount = None`));
      }
    }
  }
  return out;
}
