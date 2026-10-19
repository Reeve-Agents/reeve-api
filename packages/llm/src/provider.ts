import type { PackId, Rulebook } from "@reeve/core";

/** What the model may know besides the SOP: the data's field names and types (never values) and the connected services. */
export interface SopHints {
  fields?: { name: string; type: string; values?: string[] }[];
  connectors?: string[];
  /** Real tools found on the connected services for this SOP's actions, with the arguments each requires. */
  tools?: { slug: string; description?: string; required: string[] }[];
}

/** Turns a plain-language SOP into rule cards for one domain pack. */
export interface LLMProvider {
  readonly name: string;
  parseSop(sop: string, pack?: PackId, hints?: SopHints): Promise<Rulebook>;
}

export class LLMRefusalError extends Error {}
