import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable inbox for Socket Mode envelopes: append-before-ack + a processed
 * set, so no acked envelope is lost across a crash.
 *
 * - `record(id, event)` appends the envelope to an append-only log, deduped by
 *   `envelope_id` (Slack redelivery / reconnect is a no-op).
 * - `markProcessed(id)` records that the envelope's downstream side effect
 *   (candidate recorded) is complete.
 * - `pending()` returns logged-but-unprocessed envelopes to replay on startup.
 *
 * Single-writer, like every local JSON path in gyeoljae (see the deployment
 * contract). The processed set is rewritten atomically via a temp file.
 */
export interface InboxEntry {
  envelope_id: string;
  event: Record<string, unknown>;
}

export class DurableInbox {
  private readonly logPath: string;
  private readonly processedPath: string;
  private readonly seen: Set<string>;
  private readonly processed: Set<string>;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "inbox.jsonl");
    this.processedPath = join(dir, "processed.json");
    this.seen = new Set(this.readLog().map((entry) => entry.envelope_id));
    this.processed = new Set(existsSync(this.processedPath) ? (JSON.parse(readFileSync(this.processedPath, "utf8")) as string[]) : []);
  }

  /** Append unless already logged. Returns true when newly recorded. */
  record(envelopeId: string, event: Record<string, unknown>): boolean {
    if (this.seen.has(envelopeId)) return false;
    appendFileSync(this.logPath, `${JSON.stringify({ envelope_id: envelopeId, event })}\n`);
    this.seen.add(envelopeId);
    return true;
  }

  markProcessed(envelopeId: string): void {
    if (this.processed.has(envelopeId)) return;
    this.processed.add(envelopeId);
    const tmp = `${this.processedPath}.tmp`;
    mkdirSync(dirname(this.processedPath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify([...this.processed], null, 2)}\n`);
    // Atomic replace so a crash mid-write never truncates the processed set.
    renameSync(tmp, this.processedPath);
  }

  isProcessed(envelopeId: string): boolean {
    return this.processed.has(envelopeId);
  }

  /** Logged envelopes whose side effect has not been marked processed. */
  pending(): InboxEntry[] {
    return this.readLog().filter((entry) => !this.processed.has(entry.envelope_id));
  }

  private readLog(): InboxEntry[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboxEntry);
  }
}
