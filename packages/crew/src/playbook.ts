// Task cards and target-driven playbooks. The Builder compiles them, the Auditor tests them, the
// owner approves once with a passkey, the Operator (code) runs them. The LLM only words drafts.

export type Skill = "listing_post" | "content_video" | "cs_reply" | "book_viewing" | "deposit_bill" | "contract_draft" | "accept_tenant" | "measure" | "plan_content";

export type Review =
  /** Owner taps approve on each draft before it goes out. */
  | "owner_before_publish"
  /** Sent on its own only for whitelisted intents; everything else goes to the owner. */
  | "auto_if_whitelisted_intent"
  /** Needs the owner's passkey. */
  | "owner_passkey"
  /** Payment step: runs alone only while the amount fits the bound the owner approved. */
  | "auto_within_bound"
  /** Internal step, nothing leaves Reeve. */
  | "none";

export type Trigger =
  | { schedule: { every: "day" | "week"; slots: string[] } }
  | { inbound: "whatsapp" | "telegram" | "instagram" }
  | { event: string };

export interface TaskCard {
  id: string;
  title: string;
  /** The SOP sentence this card was compiled from. */
  source_quote: string;
  trigger: Trigger;
  recipe: { skill: Skill; brief: string; inputs: string[] };
  /** Validator rule ids the output must pass. */
  checks: string[];
  review: Review;
  publish: { connector: string; tool: string } | null;
  /** Money this step moves, if any (deposit bill). */
  payment?: { amount_idr: number; rail: "xendit" | "stripe" | "mock" };
  budget: { max_worker_calls_per_day: number; cost_idr_per_call: number };
  /** For the earned-autonomy ladder. */
  action_class: string;
  /** cs_reply only: intents allowed to be answered without the owner. */
  whitelisted_intents?: string[];
}

export interface PlaybookStep extends TaskCard {
  /** Event that fires this step. */
  when: string;
  /** Events this step can produce. */
  emits: string[];
}

export interface Playbook {
  id: string;
  title: string;
  workspace: string;
  source_quote: string;
  goal: { metric: string; target: number; by: string };
  /** Events that come from business data, not from a step (e.g. "room_vacant"). */
  starts: string[];
  steps: PlaybookStep[];
  budget: { max_cost_idr: number; max_worker_calls: number; max_payment_idr: number };
  stop: { on_target: boolean; on_budget: boolean; by_date?: string };
  starts_on: string;
}

/** Intents the CS step may answer alone, grounded in facts from code. Everything else escalates. */
export const KOS_WHITELIST = ["harga", "fasilitas", "lokasi", "ketersediaan", "jadwal_survei", "status_tagihan"] as const;

export function daysBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
}
