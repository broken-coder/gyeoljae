/**
 * Approval-reply validation for the round-trip loop.
 *
 * Policy source (ported): a short reply counts as approval ONLY when it is
 * attached to a current scoped proposal — here, a chat reply in the SAME
 * thread as a message whose ledger record carries the `## Approval
 * requested` marker. Anything that adds conditions or widens scope is a new
 * proposal, never an approval. Ambiguity degrades to needs-human.
 *
 * Output is content-free: verdict, refs, and timestamps — never reply text.
 */

/** Exact short approvals recognized by policy (trimmed; latin lowered). */
const SHORT_APPROVALS = new Set(["승인", "동의", "진행", "좋아", "네", "a", "approved", "approve"]);

/** Long form: `승인: <ref>` optionally followed by 범위/조건 lines is NOT auto-approved here; only the bare ref form is. */
const LONG_FORM = /^승인\s*:\s*(\S+)\s*$/;

export interface ApprovalReply {
  channel_id: string;
  /** Replies outside a thread can never be approvals. */
  thread_ts?: string;
  ts: string;
  user?: string;
  text?: string;
}

export interface PendingRequest {
  /** `${channel_id}:${thread_ts}` of the thread carrying the request. */
  thread_key: string;
  ledger_ref: string;
}

export type ApprovalVerdict =
  | "approved-candidate"
  | "needs-human"
  | "not-approval";

export interface CandidateApproval {
  verdict: ApprovalVerdict;
  thread_key: string;
  ledger_ref: string | null;
  reply_ts: string;
  approver: string | null;
  /** Why the verdict fell where it did — enum-ish, content-free. */
  reason:
    | "short-approval-in-request-thread"
    | "long-form-ref-match"
    | "long-form-ref-mismatch"
    | "modified-or-widened-reply"
    | "no-pending-request-thread"
    | "not-in-thread";
}

export function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function validateApprovalReply(
  reply: ApprovalReply,
  pending: Map<string, PendingRequest>,
): CandidateApproval {
  const base = {
    reply_ts: reply.ts,
    approver: reply.user ?? null,
  };

  if (!reply.thread_ts) {
    return { ...base, verdict: "not-approval", thread_key: "", ledger_ref: null, reason: "not-in-thread" };
  }

  const key = threadKey(reply.channel_id, reply.thread_ts);
  const request = pending.get(key);
  if (!request) {
    return { ...base, verdict: "not-approval", thread_key: key, ledger_ref: null, reason: "no-pending-request-thread" };
  }

  const text = (reply.text ?? "").trim();
  const normalized = text.toLowerCase();

  if (SHORT_APPROVALS.has(normalized)) {
    return {
      ...base,
      verdict: "approved-candidate",
      thread_key: key,
      ledger_ref: request.ledger_ref,
      reason: "short-approval-in-request-thread",
    };
  }

  const longForm = text.match(LONG_FORM);
  if (longForm) {
    const refMatches = longForm[1] === request.ledger_ref;
    return {
      ...base,
      verdict: refMatches ? "approved-candidate" : "needs-human",
      thread_key: key,
      ledger_ref: request.ledger_ref,
      reason: refMatches ? "long-form-ref-match" : "long-form-ref-mismatch",
    };
  }

  // In the request thread but not an exact approval form: could be a
  // condition, a scope change, or a question. Policy: that is a new
  // proposal / human matter, never an auto-approval.
  return {
    ...base,
    verdict: "needs-human",
    thread_key: key,
    ledger_ref: request.ledger_ref,
    reason: "modified-or-widened-reply",
  };
}
