import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rulebook, type PackId } from "@reeve/core";

/** Absolute path of the reeve/ repo root (packages/pipeline/src → ../../..). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The sample business for each domain pack, under fixtures/. */
export const PACK_FIXTURE: Record<PackId, string> = { "rent-collection": "kos-melati", minimarket: "minimarket", generic: "bimbel-cerdas" };

export function loadFixtureSop(fixture = "kos-melati"): string {
  return readFileSync(join(repoRoot, `fixtures/${fixture}/sop.md`), "utf8");
}

export function loadFixtureRulebook(fixture = "kos-melati"): Rulebook {
  return Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, `fixtures/${fixture}/rulebook.json`), "utf8")));
}
