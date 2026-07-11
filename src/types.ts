/**
 * Gyeoljae wire types.
 *
 * Envelope JSON keys are snake_case on purpose: they are the wire format,
 * kept byte-compatible with the original Ruby shadow implementation so its
 * test fixtures serve as the golden spec for this port.
 */

export interface SlackFileRef {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  sha256?: string;
}

export interface ThreadMessage {
  ts: string;
  text?: string;
  user?: string;
  permalink?: string;
  edited?: { ts: string };
  files?: SlackFileRef[];
}

/** One chat thread mapped to (at most) one ledger reference. */
export interface ThreadDocument {
  ledger_ref: string | null;
  channel_id: string;
  thread_ts: string;
  messages: ThreadMessage[];
}

export type IntakeKind = "message" | "file" | "approval" | "billing-source" | "unknown";

export type ClassificationStatus =
  | "unclassified"
  | "routine"
  | "agent-required"
  | "needs-human"
  | "blocked";

export type ActionClass =
  | "record-only"
  | "record-approval-only"
  | "routine-update"
  | "agent-required"
  | "needs-human";

import type { RedactionManifest } from "./redaction/pipeline.js";

export interface Envelope {
  source: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  edited_ts: string | null;
  version: number;
  permalink: string | null;
  ledger_ref: string | null;
  intake_kind: IntakeKind;
  file_refs: SlackFileRef[];
  /** Always null in shadow mode; excerpts are an active-stage, rule-gated feature. */
  text_excerpt: string | null;
  sensitive_review: boolean;
  classification_status: ClassificationStatus;
  dedup_key: string;
  recorded_at: string;
  recorded_by: string;
  /** "clean" when the scanner found nothing; "redacted" when tokens were substituted. */
  redaction_status: "clean" | "redacted";
  /** Message text with each secret/PII finding replaced by an HMAC-derived token. */
  redacted_text: string;
  redaction_manifest: RedactionManifest;
  /** Internal only: source text for deterministic classification. Stripped before any persistence or output. */
  shadow_source_text?: string;
}

export interface ClassifiedEnvelope extends Envelope {
  action_class: ActionClass;
}

/** A ledger is wherever your operating truth lives: Paperclip, GitHub Issues, Linear, ... */
export interface LedgerAdapter {
  /** Record an intake event. Must be idempotent on envelope.dedup_key. */
  recordIntake(envelope: ClassifiedEnvelope): Promise<void>;
  /** Post a human-readable comment (e.g. approval request or run summary). */
  comment(ledgerRef: string, body: string): Promise<void>;
}

/** A chat surface: Slack today, others via adapters. */
export interface ChatAdapter {
  /**
   * Post a non-sensitive notification (issue id/title/status/link only).
   * May return an adapter-specific receipt (e.g. posted message ts) that
   * Notifier.deliver passes through to callers.
   */
  notify(channel: string, body: string): Promise<unknown>;
}
