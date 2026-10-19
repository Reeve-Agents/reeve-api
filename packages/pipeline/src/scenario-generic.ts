import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "@reeve/connectors";
import type { GenericScenario, Rulebook } from "@reeve/core";
import { repoRoot } from "./paths";

/** A generic scenario from an owner's records: 30 days from Monday 2 Nov 2026, with optional field changes. */
export function genericScenario(rb: Rulebook, records: GenericScenario["records"], updates: GenericScenario["updates"] = [], days = 30): GenericScenario {
  return { pack: "generic", start_date: "2026-11-02", days, key_field: rb.data?.key_field ?? "id", records, updates };
}

/** Bimbel Cerdas: 12 students from the sample sheet, four payments and one package top-up during November. */
export function bimbelRecords(): { records: GenericScenario["records"]; updates: GenericScenario["updates"] } {
  const dir = join(repoRoot, "fixtures/bimbel-cerdas");
  return {
    records: parseCsv(readFileSync(join(dir, "data.csv"), "utf8")),
    updates: JSON.parse(readFileSync(join(dir, "updates.json"), "utf8")) as GenericScenario["updates"],
  };
}
