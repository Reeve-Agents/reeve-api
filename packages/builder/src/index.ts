import { packOf, Rulebook, validateRulebook, type PackId, type RulebookIssue } from "@reeve/core";
import type { LLMProvider, SopHints } from "@reeve/llm";
import { canonicalJson, sha256 } from "@reeve/receipts";
import { generateBuilderTestsPy, generateRulesPy, modelFromRulebook, type InjectedBug as RentBug } from "./codegen";
import { generateGenericBuilderTestsPy, generateGenericRulesPy, type GenericBug } from "./codegen-generic";
import { generateStockBuilderTestsPy, generateStockRulesPy, stockModelFromRulebook, type StockBug } from "./codegen-stock";

export { modelFromRulebook, generateRulesPy, generateBuilderTestsPy, type BuilderModel } from "./codegen";
export { stockModelFromRulebook, generateStockRulesPy, generateStockBuilderTestsPy, type StockModel } from "./codegen-stock";
export { generateGenericRulesPy, generateGenericBuilderTestsPy, type GenericBug } from "./codegen-generic";

/** Deliberate defects, used only to show that the Auditor catches Builder mistakes (one per pack). */
export type InjectedBug = RentBug | StockBug | GenericBug;

export interface ParsedSop {
  rulebook: Rulebook;
  issues: RulebookIssue[];
  provider: string;
}

/** Phase 1: plain-language SOP → structured rule cards (+ clarifying questions) for one domain pack. */
export async function parseSop(provider: LLMProvider, sop: string, pack: PackId = "rent-collection", hints?: SopHints): Promise<ParsedSop> {
  const rulebook = Rulebook.parse(await provider.parseSop(sop, pack, hints));
  return { rulebook, issues: validateRulebook(rulebook), provider: provider.name };
}

export interface CompiledSop {
  rulebookHash: string;
  files: { "rules.py": string; "test_builder.py": string };
}

/** Phase 1 → 2: rule cards → executable Python rules + the Builder's own tests. Deterministic: same rulebook, same code. */
export function compile(rulebook: Rulebook, opts: { bugs?: InjectedBug[] } = {}): CompiledSop {
  const rulebookHash = sha256(canonicalJson(rulebook));
  const bugs = opts.bugs ?? [];
  if (packOf(rulebook) === "generic") {
    const gbugs = bugs.filter((b): b is GenericBug => b === "ignore_never_rules");
    return { rulebookHash, files: { "rules.py": generateGenericRulesPy(rulebook, rulebookHash, gbugs), "test_builder.py": generateGenericBuilderTestsPy(rulebook) } };
  }
  if (packOf(rulebook) === "minimarket") {
    const model = stockModelFromRulebook(rulebook, bugs.filter((b): b is StockBug => b === "ignore_markdown_floor"));
    return { rulebookHash, files: { "rules.py": generateStockRulesPy(model, rulebookHash), "test_builder.py": generateStockBuilderTestsPy(model) } };
  }
  const model = modelFromRulebook(rulebook, bugs.filter((b): b is RentBug => b === "ignore_tenure_grace"));
  return {
    rulebookHash,
    files: {
      "rules.py": generateRulesPy(model, rulebookHash),
      "test_builder.py": generateBuilderTestsPy(model),
    },
  };
}
