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

/** Joins whatever proposal identity fields the source supplies into a stable key fragment. */
function proposalIdentity(source: { proposal_id?: string; proposal_digest?: string; version?: number }): string | undefined {
  const parts = [source.proposal_id, source.proposal_digest, source.version].filter((part) => part !== undefined);
  return parts.length ? parts.join(":") : undefined;
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

    for (const item of items) {
      if (this.closedStatuses.has(item.status)) continue;
      const hasRequest = this.hasMarker(item, this.requestMarker);
      const hasDone = this.hasMarker(item, this.doneMarker);

      if (hasDone) {
        const key = this.cycleKey(item, "done");
        if (item.status !== this.doneStatus && !this.state.has(key)) {
          await this.control.transition(item.ref, "done", this.transitionNote);
          this.state.add(key);
          summary.done += 1;
          const delivered = await this.notifier.deliver([this.event(item, "done", `${key}:watcher`)]);
          summary.notified += delivered.length;
        }
        continue;
      }

      if (hasRequest) {
        const blockedKey = this.cycleKey(item, "blocked");
        if (item.status !== this.blockedStatus && !this.state.has(blockedKey)) {
          await this.control.transition(item.ref, "blocked", this.transitionNote);
          this.state.add(blockedKey);
          summary.blocked += 1;
        }
        const delivered = await this.notifier.deliver([
          this.event(item, "approval-needed", this.cycleKey(item, "approval-needed")),
        ]);
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
   * item. Any field present on both sides that differs is a mismatch; in strict
   * mode, a missing proposal_id on either side is also a mismatch (fail closed).
   */
  private identityMismatch(candidate: CandidateApproval, item: WatchItem): boolean {
    if (this.options.strictIdentity && (candidate.proposal_id === undefined || item.proposal_id === undefined)) {
      return true;
    }
    const fields = ["proposal_id", "proposal_digest", "version"] as const;
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
