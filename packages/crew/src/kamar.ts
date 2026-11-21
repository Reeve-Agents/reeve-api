// Playbook B "kamar kosong terisi sendiri": vacancy -> listing -> CS on whitelisted intents ->
// viewing -> deposit bill (test-mode rail) -> contract draft -> owner passkey. Each step is a
// receipt and a Meko turn; each prospect's history is Meko memory under a pseudonym.
import { Crew, CrewError, type PasskeyProof, type ReviewItem } from "./crew";
import { KOS_DEPOSIT_IDR, KOS_FACILITIES, KOS_FACTS, KOS_LOCATION, KOS_RENT_IDR, kosListingDraft } from "./kos";
import { KOS_WHITELIST } from "./playbook";
import { AI_LABEL } from "./validator";

export type Intent = (typeof KOS_WHITELIST)[number] | "nego" | "keluhan" | "refund" | "minta_pemilik" | "tidak_jelas";

const INTENTS: [Intent, RegExp][] = [
  ["minta_pemilik", /\b(bicara|ngobrol|telepon) (dengan|sama) (pemilik|ibu kos|bapak kos|orang)|\b(admin|manusia)\b/i],
  ["refund", /\b(refund|uang kembali|balikin uang|kembalikan)\b/i],
  ["keluhan", /\b(kecewa|komplain|keluhan|jelek|kotor|marah|bohong)\b/i],
  ["nego", /\b(nego|kurangi|kurangin|diskon|lebih murah|turun(in)? harga)\b/i],
  ["status_tagihan", /\b(tagihan|sudah (saya )?bayar|sudah transfer|link bayar)\b/i],
  ["jadwal_survei", /\b(survei|survey|lihat kamar|liat kamar|datang lihat|jadwal|kapan bisa)\b/i],
  ["harga", /\b(harga|berapa|biaya|sewa(nya)?|per bulan|deposit)\b/i],
  ["fasilitas", /\b(fasilitas|wifi|wi-fi|ac|kamar mandi|dapur|parkir|kasur|lemari)\b/i],
  ["lokasi", /\b(lokasi|alamat|di ?mana|jauh|dekat|kampus|maps)\b/i],
  ["ketersediaan", /\b(kosong|tersedia|masih ada|available|ready)\b/i],
];

/** Code classifies; the first matching pattern wins, so escalations beat answerable intents. */
export function classify(text: string): Intent {
  return INTENTS.find(([, re]) => re.test(text))?.[0] ?? "tidak_jelas";
}

export function isWhitelisted(intent: Intent, allowed: readonly string[]): boolean {
  return allowed.includes(intent);
}

/** Next viewing slot: 10.00-16.00 WIB on the hour, Monday to Saturday, from tomorrow. */
export function nextSlot(today: string, booked: string[]): string {
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = 1; i < 30; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    if (day.getUTCDay() === 0) continue;
    for (let h = 10; h <= 16; h++) {
      const slot = `${day.toISOString().slice(0, 10)} ${String(h).padStart(2, "0")}:00`;
      if (!booked.includes(slot)) return slot;
    }
  }
  throw new CrewError("no viewing slot in the next 30 days");
}

function factsText(room: string): string {
  return [`Kamar ${room}`, `Sewa Rp1.500.000/bulan`, `Deposit Rp500.000`, `Fasilitas: ${KOS_FACILITIES.join(", ")}`, `Lokasi: ${KOS_LOCATION}`, `Survei: Senin-Sabtu 10.00-16.00`].join("\n");
}

function replyTemplate(intent: Intent, room: string, extra: { slot?: string; bill?: string }): string {
  const tail = ` (${AI_LABEL})`;
  switch (intent) {
    case "harga":
      return `Sewa kamar ${room} Rp1.500.000 per bulan, deposit Rp500.000 sekali di awal.${tail}`;
    case "fasilitas":
      return `Kamar ${room}: ${KOS_FACILITIES.join(", ")}.${tail}`;
    case "lokasi":
      return `Alamatnya ${KOS_LOCATION}.${tail}`;
    case "ketersediaan":
      return `Kamar ${room} masih kosong. Mau survei dulu?${tail}`;
    case "jadwal_survei":
      return `Bisa survei ${extra.slot ?? "Senin-Sabtu 10.00-16.00"} WIB. Sampai ketemu di Kos Melati.${tail}`;
    case "status_tagihan":
      return extra.bill ? `Tagihan deposit Rp500.000 sudah dibuat: ${extra.bill}${tail}` : `Belum ada tagihan untuk Anda.${tail}`;
    default:
      return "";
  }
}

export interface ProspectRecord {
  alias: string;
  room: string;
  intents: Intent[];
  viewing?: string;
  invoice?: { id: string; status: string; amount: number; payUrl?: string };
  contract?: { hash: string; review: string };
  accepted?: boolean;
}

export class KamarKosong extends Crew {
  get prospects(): Record<string, ProspectRecord> {
    return (this.state.records.prospects ??= {}) as Record<string, ProspectRecord>;
  }
  get booked(): string[] {
    return Object.values(this.prospects).flatMap((p) => (p.viewing ? [p.viewing] : []));
  }
  approveB(passkey: PasskeyProof) {
    return this.approve({ facts: KOS_FACTS, whitelist: KOS_WHITELIST, good_draft: kosListingDraft("7", "1 Desember"), passkey });
  }

  /** b1: a room becomes vacant. The Operator checks memory, the Worker drafts, the owner reviews. */
  async roomVacant(room: string, from: string): Promise<ReviewItem> {
    this.assertRunning();
    const step = this.step("b1_listing");
    const op = await this.agent("operator", `Playbook: ${this.state.playbook.title}`);
    const seen = await op.search(`kamar ${room} kosong iklan catatan pemilik`);
    const owner_note = seen.memory.find((m) => m.kind === "owner_note")?.text;
    await this.record(op, {
      input: `room_vacant: kamar ${room} mulai ${from}`,
      output: { action: "start_listing", room, step: step.id },
      reasoning: `Step ${step.id} fires on room_vacant. Memory checked for kamar ${room}${owner_note ? `: "${owner_note}" is applied to the draft brief` : ": no owner note"}. Price comes from the sheet (Rp${KOS_RENT_IDR}), not the model.`,
      action: "start_listing",
      action_class: step.action_class,
    });
    const draft = await this.draft(step, {
      brief: `Tulis iklan singkat kamar kos kosong${owner_note ? ` (catatan pemilik: ${owner_note})` : ""}.`,
      facts_text: factsText(room),
      template: kosListingDraft(room, from),
      facts: KOS_FACTS,
      subject: `kamar ${room}`,
    });
    const item = this.queue({ step: step.id, kind: "draft", subject: `kamar ${room}`, text: draft.text, receipt: this.state.decisions.at(-1)!.receipt_hash, hits: draft.hits, meta: { room } });
    return item;
  }

  /** Owner taps approve (or edits) a listing; then it is published through the connector. */
  async reviewListing(id: string, verdict: { approve: boolean; edited?: string }): Promise<void> {
    const item = this.pending(id);
    const step = this.step(item.step);
    const owner = await this.agent("owner", `Review: ${this.state.playbook.title}`);
    const text = verdict.edited ?? item.text;
    item.status = !verdict.approve ? "rejected" : verdict.edited ? "edited" : "approved";
    await this.record(owner, {
      input: `review ${item.id}: ${item.subject}`,
      output: { verdict: item.status },
      reasoning: verdict.approve ? `The owner approved the listing${verdict.edited ? " after editing it" : " unchanged"}.` : "The owner rejected the listing; nothing is published.",
      action: `review_${item.status}`,
      action_class: step.action_class,
    });
    if (!verdict.approve) return;
    const res = await this.exec(step, { caption: text, room: item.meta?.room });
    const op = await this.agent("operator", `Playbook: ${this.state.playbook.title}`);
    await this.record(op, {
      input: `publish ${item.id}`,
      output: { action: "publish", tool: step.publish!.tool, via: res.via, ok: res.ok },
      reasoning: `Approved by the owner, so step ${step.id} publishes with ${step.publish!.tool}${res.via === "log" ? " (Log connector: recorded, not sent, until Instagram is connected)" : ""}.`,
      action: "publish",
      action_class: step.action_class,
    });
  }

  /** b2/b3: a prospect writes. Code classifies; whitelisted intents are answered from facts. */
  async prospectMessage(prospectId: string, realName: string, room: string, text: string): Promise<{ intent: Intent; replied: boolean; reply?: string; escalated?: ReviewItem }> {
    this.assertRunning();
    const cs = this.step("b2_cs");
    const alias = this.ws.pseudonyms.alias(realName, "Prospek", prospectId.toUpperCase());
    const p = (this.prospects[prospectId] ??= { alias, room, intents: [] });
    const intent = classify(text);
    p.intents.push(intent);
    const op = await this.agent("operator", `CS: ${alias}`);
    await op.remember(`${alias} (kamar ${room}) bertanya: "${text}" (intent ${intent}).`, { kind: "prospect_history", prospect: prospectId.toUpperCase(), room });
    const history = await op.search(`${alias} kamar ${room} riwayat`);
    const allowed = cs.whitelisted_intents ?? [];
    const repeated = p.intents.filter((i) => i === intent).length > 2;
    const unusual = !isWhitelisted(intent, allowed) || repeated;
    const gate = this.gate(cs.action_class, unusual);
    if (unusual || gate === "ask") {
      const why = !isWhitelisted(intent, allowed) ? `intent "${intent}" is not on the whitelist (${allowed.join(", ")})` : repeated ? "the same question came three times" : "the autonomy level for cs_reply is still 'ask'";
      await this.record(op, {
        input: `${alias}: ${text}`,
        output: { action: "escalate", intent },
        reasoning: `Escalated to the owner because ${why}. History checked (${history.memory.length} memories).`,
        action: "escalate",
        action_class: cs.action_class,
      });
      const escalated = this.queue({ step: cs.id, kind: "escalation", subject: alias, text, receipt: this.state.decisions.at(-1)!.receipt_hash, meta: { prospect: prospectId, intent } });
      return { intent, replied: false, escalated };
    }
    let slot: string | undefined;
    if (intent === "jadwal_survei") slot = p.viewing ?? nextSlot(this.today(), this.booked);
    const reply = replyTemplate(intent, room, { slot, bill: p.invoice?.payUrl });
    const res = await this.exec(cs, { to: prospectId, text: reply });
    await this.record(op, {
      input: `${alias}: ${text}`,
      output: { action: "reply", intent, via: res.via, reply },
      reasoning: `Intent "${intent}" is whitelisted, so the reply is sent from facts in code (price Rp${KOS_RENT_IDR}, deposit Rp${KOS_DEPOSIT_IDR}). ${history.memory.length} earlier messages from ${alias} were checked first.`,
      action: "reply",
      action_class: cs.action_class,
    });
    if (slot && !p.viewing) await this.bookViewing(prospectId, slot);
    return { intent, replied: true, reply };
  }

  /** b3: book the viewing slot (Calendar connector, else the Log). */
  async bookViewing(prospectId: string, slot: string): Promise<void> {
    const step = this.step("b3_viewing");
    const p = this.prospects[prospectId]!;
    if (this.booked.includes(slot)) throw new CrewError(`slot ${slot} is taken`);
    p.viewing = slot;
    const res = await this.exec(step, { title: `Survei kamar ${p.room}: ${p.alias}`, start: slot, duration_min: 30 });
    const op = await this.agent("operator", `CS: ${p.alias}`);
    await this.record(op, {
      input: `viewing_requested: ${p.alias}, kamar ${p.room}`,
      output: { action: "book_viewing", slot, via: res.via },
      reasoning: `The first free slot Monday-Saturday 10.00-16.00 is ${slot}; no other viewing holds it.`,
      action: "book_viewing",
      action_class: step.action_class,
    });
  }

  /** b4: after the viewing the prospect wants the room; bill the deposit if it fits the bound. */
  async viewingDone(prospectId: string, wantsRoom: boolean): Promise<void> {
    this.assertRunning();
    const step = this.step("b4_deposit");
    const p = this.prospects[prospectId];
    if (!p?.viewing) throw new CrewError(`${prospectId} has no viewing`);
    const op = await this.agent("operator", `CS: ${p.alias}`);
    const amount = step.payment!.amount_idr;
    const bound = this.state.playbook.budget.max_payment_idr;
    if (!wantsRoom) {
      await this.record(op, { input: `viewing_done: ${p.alias}`, output: { action: "no_bill" }, reasoning: "The prospect did not take the room, so no deposit bill is made.", action: "no_bill", action_class: step.action_class });
      return;
    }
    if (amount > bound || this.gate(step.action_class) === "ask") {
      await this.record(op, { input: `viewing_done: ${p.alias}`, output: { action: "ask_owner", amount }, reasoning: amount > bound ? `Deposit Rp${amount} is above the approved bound Rp${bound}.` : "The autonomy level for deposit_bill is 'ask'.", action: "ask_owner", action_class: step.action_class });
      this.queue({ step: step.id, kind: "action", subject: p.alias, text: `Tagih deposit Rp${amount}?`, receipt: this.state.decisions.at(-1)!.receipt_hash, meta: { prospect: prospectId } });
      return;
    }
    const inv = await this.deps.rail.createInvoice({
      customer: { ref: prospectId, name: p.alias },
      amount,
      description: `Deposit kamar ${p.room} Kos Melati`,
      dueDate: this.today(),
      idempotencyKey: `${this.state.playbook.id}:${prospectId}:deposit`,
    });
    p.invoice = { id: inv.invoiceId, status: inv.status, amount: inv.amount, payUrl: inv.payUrl };
    await this.record(op, {
      input: `viewing_done: ${p.alias} wants kamar ${p.room}`,
      output: { action: "deposit_bill", amount, rail: this.deps.rail.name, test_mode: this.deps.rail.testMode, invoice: inv.invoiceId },
      reasoning: `Deposit Rp${amount} is within the owner-approved bound Rp${bound} (review auto_within_bound), so step ${step.id} bills it on ${this.deps.rail.name} in test mode.`,
      action: "deposit_bill",
      action_class: step.action_class,
    });
  }

  /** b5: deposit paid (rail webhook or test-mode simulation) -> contract draft for the owner. */
  async depositPaid(prospectId: string): Promise<ReviewItem> {
    const step = this.step("b5_contract");
    const p = this.prospects[prospectId];
    if (!p?.invoice) throw new CrewError(`${prospectId} has no deposit bill`);
    const inv = await this.deps.rail.getInvoice(p.invoice.id);
    if (inv.status !== "paid") throw new CrewError(`deposit ${p.invoice.id} is ${inv.status}`);
    p.invoice.status = "paid";
    const contract = [
      `PERJANJIAN SEWA KAMAR KOS MELATI`,
      `Penyewa: ${p.alias}. Kamar: ${p.room}. Mulai: ${this.today()}.`,
      `Sewa Rp1.500.000 per bulan, dibayar paling lambat tanggal 5. Deposit Rp500.000 sudah diterima (${inv.invoiceId}).`,
      `Telat bayar lebih dari 7 hari dikenai denda Rp50.000, kecuali ada izin pemilik.`,
      `(${AI_LABEL}; diperiksa pemilik sebelum ditandatangani)`,
    ].join("\n");
    const op = await this.agent("operator", `CS: ${p.alias}`);
    const art = await op.artifact(`kontrak-${prospectId}.txt`, contract, "text/plain");
    p.contract = { hash: art.content_hash, review: "" };
    await this.record(op, {
      input: `deposit_paid: ${inv.invoiceId} Rp${inv.amountPaid}`,
      output: { action: "contract_draft", artifact: art.content_hash },
      reasoning: `Deposit ${inv.invoiceId} is paid on the rail, so step ${step.id} drafts the contract from the owner's template; the real name is filled in by the owner, never sent to Meko.`,
      action: "contract_draft",
      action_class: step.action_class,
    });
    const item = this.queue({ step: "b6_accept", kind: "contract", subject: p.alias, text: contract, receipt: this.state.decisions.at(-1)!.receipt_hash, meta: { prospect: prospectId, artifact: art.content_hash } });
    p.contract.review = item.id;
    return item;
  }

  /** b6: the owner accepts the tenant with a passkey. The room is filled; the metric moves. */
  async acceptTenant(reviewId: string, passkey: PasskeyProof): Promise<{ filled: number; stopped: boolean }> {
    const item = this.pending(reviewId);
    if (item.kind !== "contract") throw new CrewError(`${reviewId} is not a contract`);
    const p = this.prospects[String(item.meta?.prospect)]!;
    item.status = "approved";
    p.accepted = true;
    this.state.metric += 1;
    const owner = await this.agent("owner", `Review: ${this.state.playbook.title}`);
    await owner.remember(`${p.alias} diterima sebagai penghuni kamar ${p.room} pada ${this.today()}.`, { kind: "tenant_accepted", room: p.room }, { promote: true });
    await this.record(owner, {
      input: `accept ${p.alias} for kamar ${p.room}`,
      output: { action: "accept_tenant", contract: p.contract?.hash, method: passkey.method },
      reasoning: `The owner accepted the tenant with a ${passkey.method === "passkey" ? "passkey" : "demo passkey (offline seed)"}; the approval binds the contract artifact ${p.contract?.hash.slice(0, 12)}. rooms_filled is now ${this.state.metric}/${this.state.playbook.goal.target}.`,
      action: "accept_tenant",
      action_class: "accept_tenant",
    });
    const stopped = await this.checkStop();
    return { filled: this.state.metric, stopped };
  }
}
