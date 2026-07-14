import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable notification outbox: pending → sending → sent, with the event and
 * the chat receipt stored against the event key.
 *
 * "pending" is claimed durably BEFORE the ledger transition that makes the
 * event unrepeatable (a done item leaves the open set, so a later pass can
 * never rebuild its event). "sending" is written before the remote post and
 * "sent" after it succeeds; a crash between post and confirmation leaves the
 * key in "sending" — a known-uncertain state the Notifier reconciles instead
 * of blindly resending. Unsent entries carry their event so `drain()` can
 * retry them even when the originating item no longer appears in a pass.
 * Single-writer; the file is replaced atomically via a temp-file rename.
 */
export type OutboxState = "pending" | "sending" | "sent";

interface OutboxRecord {
  state: OutboxState;
  receipt?: unknown;
  /** The notification event, kept until sent so crashed sends can be drained. */
  event?: unknown;
}

export interface UnsentEntry {
  event_key: string;
  state: OutboxState;
  event?: unknown;
}

export class Outbox {
  private readonly records: Map<string, OutboxRecord>;

  constructor(private readonly path: string) {
    this.records = new Map(
      existsSync(path) ? (Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, OutboxRecord>)) : [],
    );
  }

  get(eventKey: string): OutboxState | undefined {
    return this.records.get(eventKey)?.state;
  }

  receipt(eventKey: string): unknown {
    return this.records.get(eventKey)?.receipt;
  }

  /** Durably record the event before the transition that makes it unrepeatable. */
  markPending(eventKey: string, event: unknown): void {
    if (this.records.has(eventKey)) return; // never regress sending/sent
    this.records.set(eventKey, { state: "pending", event });
    this.flush();
  }

  /** Claim intent to send, durably, before the remote post. */
  markSending(eventKey: string, event?: unknown): void {
    const kept = event ?? this.records.get(eventKey)?.event;
    this.records.set(eventKey, { state: "sending", ...(kept !== undefined ? { event: kept } : {}) });
    this.flush();
  }

  /** Confirm the post landed and store its receipt; the event is no longer needed. */
  markSent(eventKey: string, receipt: unknown): void {
    this.records.set(eventKey, { state: "sent", receipt });
    this.flush();
  }

  /** Entries left pending/sending by a crashed pass, for the Notifier to drain. */
  unsent(): UnsentEntry[] {
    const entries: UnsentEntry[] = [];
    for (const [eventKey, record] of this.records) {
      if (record.state === "sent") continue;
      entries.push({ event_key: eventKey, state: record.state, ...(record.event !== undefined ? { event: record.event } : {}) });
    }
    return entries;
  }

  private flush(): void {
    const object = Object.fromEntries(this.records);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(object, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
