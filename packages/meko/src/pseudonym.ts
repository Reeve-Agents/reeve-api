// Pseudonymise people before any text leaves Reeve (LLM calls, Meko). Meko does not anonymise.
// Real names map to stable aliases ("Penghuni K3", "Prospek P2"); the map stays in Reeve's store.

const NIK = /\b\d{16}\b/g; // Indonesian ID number
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+62|\b62|\b0)8\d{7,11}\b/g;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Pseudonymiser {
  private readonly toAlias = new Map<string, string>();
  private counters: Record<string, number> = {};

  constructor(entries: Record<string, string> = {}) {
    for (const [real, alias] of Object.entries(entries)) this.set(real, alias);
  }

  set(real: string, alias: string): string {
    if (real.trim()) this.toAlias.set(real.trim(), alias);
    return alias;
  }

  /** Alias for a person, made once and then reused. `key` (room, prospect id) keeps it readable. */
  alias(real: string, kind = "Penghuni", key?: string): string {
    const known = this.toAlias.get(real.trim());
    if (known) return known;
    const n = (this.counters[kind] = (this.counters[kind] ?? 0) + 1);
    return this.set(real, `${kind} ${key ?? n}`);
  }

  /** Replaces every known name (longest first) and masks NIK, card and phone numbers. */
  redact(text: string): string {
    let out = text;
    const names = [...this.toAlias.keys()].sort((a, b) => b.length - a.length);
    for (const real of names) out = out.replace(new RegExp(`\\b${escape(real)}\\b`, "gi"), this.toAlias.get(real)!);
    return out.replace(NIK, "[NIK]").replace(CARD, "[nomor kartu]").replace(PHONE, "[nomor HP]");
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.toAlias);
  }
}
