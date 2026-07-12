import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChatAdapter } from "../types.js";
import type { Outbox } from "./outbox.js";

/**
 * A ledger-side occurrence a human should hear about.
 * Produced by a LedgerWatcher (adapter-specific); consumed by the Notifier.
 */
export interface LedgerEvent {
  /** Idempotency key, e.g. "EX-12:approval-needed:2026-07-10T12:00:00Z". */
  event_key: string;
  kind: "approval-needed" | "done" | "blocked" | "needs-human";
  ledger_ref: string;
  title: string;
  url?: string;
}

/** Content-free notification line: refs, statuses, and links only. */
export function renderNotification(event: LedgerEvent): string {
  const headline = {
    "approval-needed": "🔏 Approval needed",
    done: "✅ Done",
    blocked: "⛔ Blocked",
    "needs-human": "🙋 Needs a human",
  }[event.kind];
  const link = event.url ? ` — ${event.url}` : "";
  return `${headline}: ${event.ledger_ref} ${event.title}${link}`;
}

/** Given a leftover "sending" event, return its receipt if the post is found to have landed, else null. */
export type Reconcile = (event: LedgerEvent) => Promise<unknown | null>;

export interface NotifierOptions {
  /**
   * Durable outbox (pending → sending → sent + receipts). When provided, the
   * intent is recorded before the post and the receipt after; a crash between
   * the two leaves the key in "sending", which is reconciled (not blindly
   * resent) on the next pass.
   */
  outbox?: Outbox;
  /** Resolve a "sending" leftover: receipt if the post already landed, else null (→ resend). */
  reconcile?: Reconcile;
}

/**
 * Routes ledger events with deduplicated at-least-once delivery.
 *
 * Default (seen-set) mode: a local JSON file of already-notified event keys;
 * a crash after the remote send but before the checkpoint can repeat a
 * notification. Pass an `outbox` to upgrade to explicit pending → sending →
 * sent state with stored receipts and reconciliation of the post crash window.
 */
export class Notifier {
  private readonly outbox?: Outbox;
  private readonly reconcile?: Reconcile;

  constructor(
    private readonly chat: ChatAdapter,
    private readonly channel: string,
    private readonly statePath: string,
    options: NotifierOptions = {},
  ) {
    if (options.outbox) this.outbox = options.outbox;
    if (options.reconcile) this.reconcile = options.reconcile;
  }

  async deliver(events: LedgerEvent[]): Promise<Array<{ event: LedgerEvent; receipt: unknown }>> {
    return this.outbox ? this.deliverViaOutbox(events, this.outbox) : this.deliverViaSeenSet(events);
  }

  private async deliverViaSeenSet(events: LedgerEvent[]): Promise<Array<{ event: LedgerEvent; receipt: unknown }>> {
    const seen = new Set(this.readState());
    const delivered: Array<{ event: LedgerEvent; receipt: unknown }> = [];

    for (const event of events) {
      if (seen.has(event.event_key)) continue;
      const receipt = await this.chat.notify(this.channel, renderNotification(event));
      seen.add(event.event_key);
      this.writeState([...seen]); // persist after each send: a crash mid-batch must not re-send
      delivered.push({ event, receipt });
    }
    return delivered;
  }

  private async deliverViaOutbox(
    events: LedgerEvent[],
    outbox: Outbox,
  ): Promise<Array<{ event: LedgerEvent; receipt: unknown }>> {
    const delivered: Array<{ event: LedgerEvent; receipt: unknown }> = [];

    for (const event of events) {
      const state = outbox.get(event.event_key);
      if (state === "sent") continue; // already delivered; receipt on file

      if (state === "sending") {
        // Post crash window: a prior post may have landed. Reconcile before resending.
        const found = this.reconcile ? await this.reconcile(event) : null;
        if (found !== null && found !== undefined) {
          outbox.markSent(event.event_key, found);
          continue;
        }
      }

      outbox.markSending(event.event_key); // durable intent BEFORE the post
      const receipt = await this.chat.notify(this.channel, renderNotification(event));
      outbox.markSent(event.event_key, receipt);
      delivered.push({ event, receipt });
    }
    return delivered;
  }

  private readState(): string[] {
    if (!existsSync(this.statePath)) return [];
    return JSON.parse(readFileSync(this.statePath, "utf8")) as string[];
  }

  private writeState(keys: string[]): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(keys, null, 2)}\n`);
  }
}
