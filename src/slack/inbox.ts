import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable inbox for Socket Mode approvals: append-before-ack + a processed
 * set, so no acked envelope is lost across a crash.
 *
 * Content-free by construction. The caller validates each envelope BEFORE
 * persisting and stores only the resulting content-free payload (a candidate
 * approval — refs/verdict/ts, never message text or raw Slack metadata). The
 * raw event never touches disk, so the durable journal cannot leak message
 * bodies (the "bodies never persist" invariant holds here too).
 *
 * - `record(id, payload)` appends unless the envelope id is already logged
 *   (Slack redelivery / reconnect is a no-op).
 * - `markProcessed(id)` records that the payload's downstream side effect
 *   (candidate written to output) is complete — committed to disk BEFORE the
 *   in-memory set is updated, so a failed write never diverges the two.
 * - `pending()` returns logged-but-unprocessed payloads to replay on startup.
 *
 * Single-writer, like every local JSON path in gyeoljae. The processed set is
 * rewritten atomically via a temp file + rename.
 */
export interface InboxEntry<T> {
  envelope_id: string;
  payload: T;
}

export class DurableInbox<T = unknown> {
  private readonly logPath: string;
  private readonly processedPath: string;
  private readonly seen: Set<string>;
  private readonly processed: Set<string>;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "inbox.jsonl");
    this.processedPath = join(dir, "processed.json");
    this.seen = new Set(this.readLog().map((entry) => entry.envelope_id));
    this.processed = new Set(
      existsSync(this.processedPath) ? (JSON.parse(readFileSync(this.processedPath, "utf8")) as string[]) : [],
    );
  }

  /** Append a content-free payload unless already logged. Returns true when newly recorded. */
  record(envelopeId: string, payload: T): boolean {
    if (this.seen.has(envelopeId)) return false;
    appendFileSync(this.logPath, `${JSON.stringify({ envelope_id: envelopeId, payload })}\n`);
    this.seen.add(envelopeId);
    return true;
  }

  markProcessed(envelopeId: string): void {
    if (this.processed.has(envelopeId)) return;
    // Commit to disk first, then update memory — a failed write must not leave
    // this instance thinking the id is processed while a restart would replay it.
    const next = [...this.processed, envelopeId];
    const tmp = `${this.processedPath}.tmp`;
    mkdirSync(dirname(this.processedPath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.processedPath);
    this.processed.add(envelopeId);
  }

  isProcessed(envelopeId: string): boolean {
    return this.processed.has(envelopeId);
  }

  /** Logged payloads whose side effect has not been marked processed. */
  pending(): InboxEntry<T>[] {
    return this.readLog().filter((entry) => !this.processed.has(entry.envelope_id));
  }

  private readLog(): InboxEntry<T>[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboxEntry<T>);
  }
}
