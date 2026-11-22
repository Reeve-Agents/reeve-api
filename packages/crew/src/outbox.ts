// Undo window done truthfully. An action that runs by itself is STAGED first: it waits UNDO_WINDOW_MS
// (10 minutes) in the outbox and is only executed when the window has passed. Undo before then cancels
// it for real (it is never executed) and, like any undo, drops the class one level. After the window
// the action has run and cannot be undone. Every step is a traced decision: auto_stage, auto_run, undo.
// The executor is injected (the Log connector in the demo and the API), so nothing here sends anything.
import type { MekoWorkspace } from "@reeve/meko";
import type { ExecResult } from "./crew";
import { Ladder, type Level, UNDO_WINDOW_MS } from "./ladder";

export interface OutboxItem {
  id: string;
  action_class: string;
  tool: string;
  /** Pseudonymous ids only ("K05"), never names. */
  args: Record<string, unknown>;
  subject?: string;
  staged_at: string;
  due_at: string;
  status: "staged" | "running" | "done" | "undone" | "failed";
  /** The auto_stage decision. */
  stage_receipt: string;
  /** The decision that made the action ("remind"...), when the caller has one. */
  source_receipt?: string;
  done_receipt?: string;
  done_at?: string;
  via?: string;
  undo_receipt?: string;
  undone_at?: string;
  error?: string;
}

export interface StageInput {
  action_class: string;
  tool: string;
  args: Record<string, unknown>;
  subject?: string;
  receipt?: string;
}

/** Why an undo was refused; `message` is Indonesian and safe to show the owner. */
export class UndoRefused extends Error {
  constructor(
    message: string,
    readonly code: "sent" | "undone" | "missing",
  ) {
    super(message);
  }
}

type Executor = (tool: string, args: Record<string, unknown>) => Promise<ExecResult>;
type StoreLike = { data: object; save(): void };

export function loadOutbox(data: object): OutboxItem[] {
  const d = data as { meko_outbox?: OutboxItem[] };
  return (d.meko_outbox ??= []);
}

const ms = (n: Date | number) => (typeof n === "number" ? n : n.getTime());

export class Outbox {
  constructor(
    readonly ws: MekoWorkspace,
    readonly store: StoreLike,
    readonly ladder: Ladder,
  ) {}

  items(): OutboxItem[] {
    return loadOutbox(this.store.data);
  }

  private async trace(title: string) {
    return this.ws.run(`run_outbox_${Date.now().toString(36)}`).agent("operator", title);
  }

  /** Puts an auto-run action in the outbox; due_at = now + 10 minutes. Nothing is executed. */
  async stage(input: StageInput, now: Date | number): Promise<OutboxItem> {
    const at = ms(now);
    const due = at + UNDO_WINDOW_MS;
    const subject = input.subject ? this.ws.pseudonyms.redact(input.subject) : undefined;
    const id = `ob_${at.toString(36)}_${this.items().length + 1}`;
    const t = await this.trace(`Antrean: ${input.action_class}`);
    const d = await t.decide({
      input: `${input.tool}${subject ? ` untuk ${subject}` : ""}`,
      output: { item: id, status: "staged", tool: input.tool, due_at: new Date(due).toISOString(), undo_until: new Date(due).toISOString(), sent: false },
      reasoning: `The class ${input.action_class} runs by itself, so the action is staged for ${UNDO_WINDOW_MS / 60_000} minutes first. The owner can cancel it until ${new Date(due).toISOString()}; after that the executor runs it once. Nothing has been sent.`,
      action: "auto_stage",
      action_class: input.action_class,
      subject,
    });
    const item: OutboxItem = { id, action_class: input.action_class, tool: input.tool, args: input.args, subject, staged_at: new Date(at).toISOString(), due_at: new Date(due).toISOString(), status: "staged", stage_receipt: d.receipt_hash, ...(input.receipt ? { source_receipt: input.receipt } : {}) };
    this.items().push(item);
    this.store.save();
    return item;
  }

  /** Executes every staged item whose window has passed, exactly once each. Returns what ran. */
  async flush(now: Date | number, execute: Executor): Promise<OutboxItem[]> {
    const at = ms(now);
    const due = this.items().filter((i) => i.status === "staged" && Date.parse(i.due_at) <= at);
    // Claim synchronously so a second flush (or an undo) racing this one cannot take the same item.
    for (const i of due) i.status = "running";
    const ran: OutboxItem[] = [];
    for (const i of due) {
      let res: ExecResult | null = null;
      try {
        res = await execute(i.tool, i.args);
      } catch (e) {
        i.error = e instanceof Error ? e.message.slice(0, 200) : "gagal";
      }
      const t = await this.trace(`Jalan: ${i.action_class}`);
      if (res?.ok) {
        const d = await t.decide({
          input: `${i.tool}${i.subject ? ` untuk ${i.subject}` : ""} (antrean ${i.id}, receipt ${i.stage_receipt.slice(0, 12)})`,
          output: { item: i.id, status: "done", via: res.via, tool: i.tool, staged_receipt: i.stage_receipt },
          reasoning: `The ${UNDO_WINDOW_MS / 60_000}-minute undo window passed without an undo, so the staged action ran once through the connector (${res.via}).`,
          action: "auto_run",
          action_class: i.action_class,
          subject: i.subject,
        });
        i.status = "done";
        i.via = res.via;
        i.done_at = new Date(at).toISOString();
        i.done_receipt = d.receipt_hash;
        ran.push(i);
      } else {
        const d = await t.decide({
          input: `${i.tool} (antrean ${i.id})`,
          output: { item: i.id, status: "failed", via: res?.via ?? "-", error: i.error ?? "connector said not ok" },
          reasoning: "The window passed but the connector did not run the action, so it is marked failed and counts as no clean run.",
          action: "auto_failed",
          action_class: i.action_class,
          subject: i.subject,
        });
        i.status = "failed";
        i.done_at = new Date(at).toISOString();
        i.done_receipt = d.receipt_hash;
      }
    }
    if (due.length) this.store.save();
    return ran;
  }

  /** Cancels a staged item before its window ends. The class drops one level and the undo is a receipt. */
  async undo(id: string, now: Date | number): Promise<{ item: OutboxItem; receipt: string; level: Level }> {
    const i = this.items().find((x) => x.id === id);
    if (!i) throw new UndoRefused("Item ini tidak ditemukan.", "missing");
    if (i.status === "undone") throw new UndoRefused("Sudah dibatalkan.", "undone");
    if (i.status !== "staged" || Date.parse(i.due_at) <= ms(now)) throw new UndoRefused("Sudah terkirim, tidak bisa dibatalkan.", "sent");
    i.status = "undone"; // claim first: flush skips it and a second undo is refused
    i.undone_at = new Date(ms(now)).toISOString();
    const detail = `batalkan ${i.id} (receipt ${i.stage_receipt.slice(0, 12)})`;
    const level = await this.ladder.demote(i.action_class, "undo", detail);
    const d = this.ws
      .decisions({ action_class: i.action_class })
      .filter((x) => x.action === "undo")
      .at(-1);
    i.undo_receipt = d?.entry_hash;
    this.store.save();
    return { item: i, receipt: i.undo_receipt ?? "", level };
  }
}
