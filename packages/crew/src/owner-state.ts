// What the owner web UI needs to survive a restart: the review queue and the autonomy ladder.
// Both live in the Meko workspace's store (`data.meko_review`, `data.meko_ladder`), next to
// `meko_links`. The CLI demo writes them; the API reads and changes them. Names never go here:
// review items hold pseudonymised subjects and drafts only.
import type { ReviewItem } from "./crew";
import type { LadderState } from "./ladder";
import { playbookB, playbookC } from "./kos";

export interface StoredReview extends ReviewItem {
  created_at: string;
  /** Set when the owner decided: when, and the receipt of the decision. */
  decided_at?: string;
  decision_receipt?: string;
  /** The draft as the Worker wrote it, kept when the owner edits. */
  original_text?: string;
}

type Data = Record<string, unknown>;

export function loadLadderState(data: object): LadderState {
  const d = data as Data;
  return (d.meko_ladder ??= { levels: {} }) as LadderState;
}

export function saveLadderState(data: object, state: LadderState): void {
  (data as Data).meko_ladder = state;
}

export function loadReview(data: object): StoredReview[] {
  const d = data as Data;
  return (d.meko_review ??= []) as StoredReview[];
}

/** Replaces the queue. Items that already exist keep their `created_at`. */
export function saveReview(data: object, items: ReviewItem[], now: () => string = () => new Date().toISOString()): StoredReview[] {
  const old = new Map(loadReview(data).map((i) => [i.id, i]));
  const next = items.map((i): StoredReview => ({ ...old.get(i.id), ...i, created_at: old.get(i.id)?.created_at ?? now() }));
  (data as Data).meko_review = next;
  return next;
}

/** The playbook step behind a review item: its action class and validator checks. */
export function stepOf(stepId: string): { action_class: string; checks: string[]; title: string } | null {
  for (const pb of [playbookB(), playbookC()]) {
    const s = pb.steps.find((x) => x.id === stepId);
    if (s) return { action_class: s.action_class, checks: s.checks, title: s.title };
  }
  return null;
}
