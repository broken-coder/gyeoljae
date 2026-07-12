/**
 * Approval-reply validation for the round-trip loop.
 *
 * Policy source (ported): a short reply counts as approval ONLY when it is
 * attached to a current scoped proposal — here, a chat reply in the SAME
 * thread as a message whose ledger record carries the `## Approval
 * requested` marker. Anything that adds conditions or widens scope is a new
 * proposal, never an approval. Ambiguity degrades to needs-human.
 *
 * Authorization is fail-closed: a reply becomes an approval candidate only
 * when an authorizer is configured AND recognizes the replying user. Missing
 * user identity, bot/system messages, an unconfigured authorizer, or an
 * unlisted approver never produce `approved-candidate`.
 *
 * Output is content-free: verdict, refs, and timestamps — never reply text.
 */

/** Default short approvals recognized by policy (trimmed; latin lowered). Override via options to tighten. */
export const DEFAULT_SHORT_APPROVALS: readonly string[] = [
  "승인",
  "동의",
  "진행",
  "좋아",
  "네",
  "a",
  "approved",
  "approve",
];

/** Long form: `승인: <ref>` — only the bare ref form is auto-approved. */
const LONG_FORM = /^승인\s*:\s*(\S+)\s*$/;

export interface ApprovalReply {
  channel_id: string;
  /** Replies outside a thread can never be approvals. */
  thread_ts?: string;
  ts: string;
  user?: string;
  text?: string;
  /** Slack sets these on bot/system messages; either present ⇒ never an approval. */
  bot_id?: string;
  subtype?: string;
}

export interface PendingRequest {
  /** `${channel_id}:${thread_ts}` of the thread carrying the request. */
  thread_key: string;
  ledger_ref: string;
}

/** Returns true only for users allowed to approve. Absence of a configured authorizer is fail-closed. */
export type Authorizer = (userId: string) => boolean;

/** Build an allowlist authorizer from a set/array of Slack user ids. */
export function allowlistAuthorizer(userIds: Iterable<string>): Authorizer {
  const allow = new Set(userIds);
  return (userId) => allow.has(userId);
}

export interface ValidateOptions {
  /** Required for any `approved-candidate`; omitting it is fail-closed. */
  authorizer?: Authorizer;
  /** Override the accepted short-approval phrases (e.g. drop ambiguous single-letter ones). */
  shortApprovals?: Iterable<string>;
}

export type ApprovalVerdict = "approved-candidate" | "needs-human" | "not-approval";

export type ApprovalReason =
  | "short-approval-in-request-thread"
  | "long-form-ref-match"
  | "long-form-ref-mismatch"
  | "modified-or-widened-reply"
  | "no-pending-request-thread"
  | "not-in-thread"
  | "bot-or-system-message"
  | "missing-approver-identity"
  | "authorization-not-configured"
  | "unauthorized-approver";

export interface CandidateApproval {
  verdict: ApprovalVerdict;
  thread_key: string;
  ledger_ref: string | null;
  reply_ts: string;
  approver: string | null;
  /** Why the verdict fell where it did — enum-ish, content-free. */
  reason: ApprovalReason;
}

export function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function validateApprovalReply(
  reply: ApprovalReply,
  pending: Map<string, PendingRequest>,
  options: ValidateOptions = {},
): CandidateApproval {
  const base = { reply_ts: reply.ts, approver: reply.user ?? null };
  const shortApprovals = new Set(options.shortApprovals ?? DEFAULT_SHORT_APPROVALS);

  // Bot/system messages can never approve, regardless of text or thread.
  if (reply.bot_id || reply.subtype) {
    return { ...base, verdict: "not-approval", thread_key: "", ledger_ref: null, reason: "bot-or-system-message" };
  }

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
  const isShort = shortApprovals.has(normalized);
  const longForm = text.match(LONG_FORM);

  // Not an approval form at all → new proposal / human matter.
  if (!isShort && !longForm) {
    return { ...base, verdict: "needs-human", thread_key: key, ledger_ref: request.ledger_ref, reason: "modified-or-widened-reply" };
  }

  // Long-form ref that doesn't match the request stays a human matter regardless of authorization.
  if (longForm && longForm[1] !== request.ledger_ref) {
    return { ...base, verdict: "needs-human", thread_key: key, ledger_ref: request.ledger_ref, reason: "long-form-ref-mismatch" };
  }

  // The reply is a well-formed approval for this request. Now gate on identity
  // and authorization — every failure below is fail-closed (never approved).
  if (!reply.user) {
    return { ...base, verdict: "needs-human", thread_key: key, ledger_ref: request.ledger_ref, reason: "missing-approver-identity" };
  }
  if (!options.authorizer) {
    return { ...base, verdict: "needs-human", thread_key: key, ledger_ref: request.ledger_ref, reason: "authorization-not-configured" };
  }
  if (!options.authorizer(reply.user)) {
    return { ...base, verdict: "needs-human", thread_key: key, ledger_ref: request.ledger_ref, reason: "unauthorized-approver" };
  }

  return {
    ...base,
    verdict: "approved-candidate",
    thread_key: key,
    ledger_ref: request.ledger_ref,
    reason: isShort ? "short-approval-in-request-thread" : "long-form-ref-match",
  };
}
