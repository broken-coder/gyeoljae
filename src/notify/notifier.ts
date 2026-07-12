import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChatAdapter } from "../types.js";

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

/**
 * Routes ledger events with deduplicated at-least-once delivery.
 *
 * Delivery state is a local JSON file of already-notified event keys, so
 * interval re-runs and nudge bursts skip checkpointed event keys. A failed
 * send is not marked notified and retries on the next run; a crash after the
 * remote send but before the checkpoint can repeat a notification.
 */
export class Notifier {
  constructor(
    private readonly chat: ChatAdapter,
    private readonly channel: string,
    private readonly statePath: string,
  ) {}

  async deliver(events: LedgerEvent[]): Promise<Array<{ event: LedgerEvent; receipt: unknown }>> {
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

  private readState(): string[] {
    if (!existsSync(this.statePath)) return [];
    return JSON.parse(readFileSync(this.statePath, "utf8")) as string[];
  }

  private writeState(keys: string[]): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(keys, null, 2)}\n`);
  }
}
