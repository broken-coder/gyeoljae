import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable notification outbox: sending → sent, with the chat
 * receipt stored against the event key.
 *
 * The state is written to disk BEFORE the remote post ("sending") and again
 * after it succeeds ("sent"). A crash between post and confirmation leaves the
 * key in "sending" — a known-uncertain state the Notifier can reconcile
 * instead of blindly resending. Single-writer; the file is replaced
 * atomically via a temp-file rename.
 */
export type OutboxState = "sending" | "sent";

interface OutboxRecord {
  state: OutboxState;
  receipt?: unknown;
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

  /** Claim intent to send, durably, before the remote post. */
  markSending(eventKey: string): void {
    this.records.set(eventKey, { state: "sending" });
    this.flush();
  }

  /** Confirm the post landed and store its receipt. */
  markSent(eventKey: string, receipt: unknown): void {
    this.records.set(eventKey, { state: "sent", receipt });
    this.flush();
  }

  private flush(): void {
    const object = Object.fromEntries(this.records);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(object, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
