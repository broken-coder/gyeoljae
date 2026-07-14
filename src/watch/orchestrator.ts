import type { CandidateApproval } from "../approval/validator.js";
import type { LedgerEvent } from "../notify/notifier.js";

/**
 * Generic watch orchestrator: the marker-to-status ownership rules, ported
 * from the deployment glue that ran the live round-trip sessions (the
 * golden spec for the tests in tests/orchestrator.test.ts).
 *
 * Rules, exactly as proven live:
 * - Markers count only at COMMENT START (quoted markers inside recorded
 *   approvals must never trigger — live-caught false positive).
 * - A done marker wins over a request marker on the same item.
 * - The orchestrator owns status transitions; agents only declare.
 * - Approved candidates are deduplicated by processed-state keys.
 * - Notification delivery is deduplicated at-least-once by the Notifier; receipts are handed to
 *   the deployment so a notification's own thread can become the reply thread.
 */

export interface WatchItem {
  /** Ledger ref, e.g. "EX-64" or "owner/repo#7". */
  ref: string;
  title: string;
  /** Adapter-native status label, compared against the configured names. */
  status: string;
  comment_bodies: string[];
  url?: string;
  /** Stable identity of the current request proposal (e.g. the request comment id); keys the notification/transition per cycle. */
  proposal_id?: string;
  /** Current digest of the live request proposal; re-checked against the candidate's captured digest before recording. */
  proposal_digest?: string;
  /** Current proposal revision, if the source tracks it. */
  version?: number;
}

/**
 * Joins whatever proposal identity fields the source supplies into a stable key
 * fragment. Field-tagged so distinct tuples can never collide (e.g. an id of
 * "a:b" vs an id "a" with digest "b").
 */
function proposalIdentity(source: { proposal_id?: string; proposal_digest?: string; version?: number }): string | undefined {
  const parts: string[] = [];
  if (source.proposal_id !== undefined) parts.push(`id=${source.proposal_id}`);
  if (source.proposal_digest !== undefined) parts.push(`digest=${source.proposal_digest}`);
  if (source.version !== undefined) parts.push(`v=${source.version}`);
  return parts.length ? parts.join("|") : undefined;
}

export interface LedgerControl {
  transition(ref: string, to: "blocked" | "done", note: string): Promise<void>;
  recordApproval(ref: string, candidate: CandidateApproval): Promise<void>;
}

/** Injectable processed-state; the caller persists it between passes. */
export interface ProcessedState {
  has(key: string): boolean;
  add(key: string): void;
}

export interface NotifierLike {
  deliver(events: LedgerEvent[]): Promise<Array<{ event: LedgerEvent; receipt: unknown }>>;
  /** Durably record an event before the transition that makes it unrepeatable (outbox-backed notifiers). */
  enqueue?(event: LedgerEvent): void;
  /** Retry pending/sending leftovers from a crashed pass; pending only when confirmPending returns true. */
  drain?(confirmPending?: (event: LedgerEvent) => boolean): Promise<Array<{ event: LedgerEvent; receipt: unknown }>>;
}

export interface OrchestratorOptions {
  requestMarker?: string;
  doneMarker?: string;
  blockedStatus?: string;
  doneStatus?: string;
  closedStatuses?: string[];
  transitionNote?: string;
  /** Called per approval-needed delivery so deployments can register the reply thread. */
  onPendingThread?: (receipt: unknown, ref: string) => void;
  /**
   * Require full proposal identity on both the candidate and the live item, and
   * reject a candidate whose identity is missing or mismatched. Use in
   * production where every request carries proposal identity; leaving it off
   * keeps the permissive fallback for adapters that don't track identity.
   */
  strictIdentity?: boolean;
}

export interface PassSummary {
  blocked: number;
  done: number;
  approvals: number;
  notified: number;
  /** Approved candidates skipped because the proposal changed since notification (digest mismatch). */
  stale_rejected: number;
}

export class WatchOrchestrator {
  private readonly requestMarker: string;
  private readonly doneMarker: string;
  private readonly blockedStatus: string;
  private readonly doneStatus: string;
  private readonly closedStatuses: Set<string>;
  private readonly transitionNote: string;

  constructor(
    private readonly control: LedgerControl,
    private readonly notifier: NotifierLike,
    private readonly state: ProcessedState,
    private readonly options: OrchestratorOptions = {},
  ) {
    this.requestMarker = options.requestMarker ?? "## Approval requested";
    this.doneMarker = options.doneMarker ?? "## 완료";
    this.blockedStatus = options.blockedStatus ?? "blocked";
    this.doneStatus = options.doneStatus ?? "done";
    this.closedStatuses = new Set(options.closedStatuses ?? ["done", "canceled", "closed"]);
    this.transitionNote = options.transitionNote ?? "Watcher: marker detected (marker-to-status ownership)";
  }

  async pass(items: WatchItem[], candidates: CandidateApproval[] = []): Promise<PassSummary> {
    const summary: PassSummary = { blocked: 0, done: 0, approvals: 0, notified: 0, stale_rejected: 0 };

    // Drain leftovers from a crashed prior pass FIRST: a done item has left the
    // open set, so its enqueued event exists nowhere but the outbox. A pending
    // done event is confirmed ONLY when its item is absent from the (complete)
    // open set — the transition that closes it must actually have landed; a
    // still-open ref means the enqueue's transition failed, so the record is
    // dropped and the item flow below retries the whole cycle. Pending
    // approval-needed events never send from here: while the item is open the
    // item flow re-delivers them itself.
    if (this.notifier.drain) {
      const openRefs = new Set(items.map((item) => item.ref));
      const confirmPending = (event: LedgerEvent): boolean => event.kind === "done" && !openRefs.has(event.ledger_ref);
      for (const entry of await this.notifier.drain(confirmPending)) {
        summary.notified += 1;
        if (entry.event.kind === "approval-needed") this.options.onPendingThread?.(entry.receipt, entry.event.ledger_ref);
      }
    }

    for (const item of items) {
      if (this.closedStatuses.has(item.status)) continue;
      const hasRequest = this.hasMarker(item, this.requestMarker);
      const hasDone = this.hasMarker(item, this.doneMarker);

      if (hasDone) {
        const key = this.cycleKey(item, "done");
        if (item.status !== this.doneStatus && !this.state.has(key)) {
          const event = this.event(item, "done", `${key}:watcher`);
          // Enqueue BEFORE the transition: once the item closes it leaves the
          // open set, and the outbox copy is the only way to retry the send.
          this.notifier.enqueue?.(event);
          await this.control.transition(item.ref, "done", this.transitionNote);
          this.state.add(key);
          summary.done += 1;
          const delivered = await this.notifier.deliver([event]);
          summary.notified += delivered.length;
        }
        continue;
      }

      if (hasRequest) {
        const blockedKey = this.cycleKey(item, "blocked");
        const approvalEvent = this.event(item, "approval-needed", this.cycleKey(item, "approval-needed"));
        if (item.status !== this.blockedStatus && !this.state.has(blockedKey)) {
          this.notifier.enqueue?.(approvalEvent);
          await this.control.transition(item.ref, "blocked", this.transitionNote);
          this.state.add(blockedKey);
          summary.blocked += 1;
        }
        const delivered = await this.notifier.deliver([approvalEvent]);
        summary.notified += delivered.length;
        for (const entry of delivered) this.options.onPendingThread?.(entry.receipt, item.ref);
      }
    }

    for (const candidate of candidates) {
      if (candidate.verdict !== "approved-candidate" || !candidate.ledger_ref) continue;
      const key = `${candidate.thread_key}:${candidate.reply_ts}`;
      if (this.state.has(key)) continue;
      const item = items.find((candidateItem) => candidateItem.ref === candidate.ledger_ref);
      if (!item) continue;
      // Record-time re-check: if the proposal the reply approved is not the
      // live proposal (any identity field differs, or — in strict mode —
      // identity is missing), do not record. Consume the key so it does not loop.
      if (this.identityMismatch(candidate, item)) {
        this.state.add(key);
        summary.stale_rejected += 1;
        continue;
      }
      await this.control.recordApproval(candidate.ledger_ref, candidate);
      this.state.add(key);
      summary.approvals += 1;
    }

    return summary;
  }

  private hasMarker(item: WatchItem, marker: string): boolean {
    return item.comment_bodies.some((body) => body.trimStart().startsWith(marker));
  }

  /**
   * True when the candidate's captured proposal identity does not match the live
   * item. Any field present on both sides that differs is a mismatch. In strict
   * mode the FULL tuple is enforced: proposal_id must exist on both sides and
   * every identity field must be present on both sides or neither — a candidate
   * carrying less identity than the live item (or more) is rejected fail-closed.
   */
  private identityMismatch(candidate: CandidateApproval, item: WatchItem): boolean {
    const fields = ["proposal_id", "proposal_digest", "version"] as const;
    if (this.options.strictIdentity) {
      if (candidate.proposal_id === undefined || item.proposal_id === undefined) return true;
      if (fields.some((field) => (candidate[field] === undefined) !== (item[field] === undefined))) return true;
    }
    return fields.some((field) => {
      const c = candidate[field];
      const i = item[field];
      return c !== undefined && i !== undefined && c !== i;
    });
  }

  /**
   * State/notification key bound to the current proposal cycle. The identity is
   * the full tuple (proposal_id, proposal_digest, version) so that editing a
   * proposal (same id, new digest) or bumping its version also produces a fresh
   * cycle — the human sees a new notification for the changed proposal. Absent
   * any identity, this falls back to the ref-only key (prior behavior).
   */
  private cycleKey(item: WatchItem, kind: string): string {
    const identity = proposalIdentity(item);
    return identity ? `${item.ref}:${kind}:${identity}` : `${item.ref}:${kind}`;
  }

  private event(item: WatchItem, kind: LedgerEvent["kind"], eventKey: string): LedgerEvent {
    const event: LedgerEvent = { event_key: eventKey, kind, ledger_ref: item.ref, title: item.title };
    if (item.url !== undefined) event.url = item.url;
    return event;
  }
}
