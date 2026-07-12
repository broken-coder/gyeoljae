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
 * - Approved candidates are consumed exactly once.
 * - Notification exactly-once is the Notifier's job; receipts are handed to
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
}

export interface PassSummary {
  blocked: number;
  done: number;
  approvals: number;
  notified: number;
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
    const summary: PassSummary = { blocked: 0, done: 0, approvals: 0, notified: 0 };

    for (const item of items) {
      if (this.closedStatuses.has(item.status)) continue;
      const hasRequest = this.hasMarker(item, this.requestMarker);
      const hasDone = this.hasMarker(item, this.doneMarker);

      if (hasDone) {
        const key = `${item.ref}:done`;
        if (item.status !== this.doneStatus && !this.state.has(key)) {
          await this.control.transition(item.ref, "done", this.transitionNote);
          this.state.add(key);
          summary.done += 1;
          const delivered = await this.notifier.deliver([this.event(item, "done", `${item.ref}:done:watcher`)]);
          summary.notified += delivered.length;
        }
        continue;
      }

      if (hasRequest) {
        const key = `${item.ref}:blocked`;
        if (item.status !== this.blockedStatus && !this.state.has(key)) {
          await this.control.transition(item.ref, "blocked", this.transitionNote);
          this.state.add(key);
          summary.blocked += 1;
        }
        const delivered = await this.notifier.deliver([
          this.event(item, "approval-needed", `${item.ref}:approval-needed`),
        ]);
        summary.notified += delivered.length;
        for (const entry of delivered) this.options.onPendingThread?.(entry.receipt, item.ref);
      }
    }

    for (const candidate of candidates) {
      if (candidate.verdict !== "approved-candidate" || !candidate.ledger_ref) continue;
      const key = `${candidate.thread_key}:${candidate.reply_ts}`;
      if (this.state.has(key)) continue;
      if (!items.some((item) => item.ref === candidate.ledger_ref)) continue;
      await this.control.recordApproval(candidate.ledger_ref, candidate);
      this.state.add(key);
      summary.approvals += 1;
    }

    return summary;
  }

  private hasMarker(item: WatchItem, marker: string): boolean {
    return item.comment_bodies.some((body) => body.trimStart().startsWith(marker));
  }

  private event(item: WatchItem, kind: LedgerEvent["kind"], eventKey: string): LedgerEvent {
    const event: LedgerEvent = { event_key: eventKey, kind, ledger_ref: item.ref, title: item.title };
    if (item.url !== undefined) event.url = item.url;
    return event;
  }
}
