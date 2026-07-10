import type { Envelope, IntakeKind, SlackFileRef, ThreadDocument, ThreadMessage } from "./types.js";

const BILLING_KIND_PATTERN = /billing|invoice|receipt/i;
const SENSITIVE_TEXT_PATTERN = /billing|invoice|receipt|subscription|구독|결제/i;

/**
 * Builds sanitized intake envelopes from a thread document.
 *
 * Invariants (ported from the Ruby shadow implementation):
 * - text_excerpt is always null in shadow mode.
 * - File refs carry metadata only; file contents are never read.
 * - Ambiguity degrades to sensitive_review=true, never to a lost record.
 */
export class EnvelopeBuilder {
  constructor(private readonly document: ThreadDocument) {}

  build(): Envelope[] {
    return this.document.messages.map((message) => this.envelopeFor(message));
  }

  private envelopeFor(message: ThreadMessage): Envelope {
    const fileRefs = (message.files ?? []).map((file) => this.fileRef(file));
    const editedTs = message.edited?.ts ?? null;
    const text = message.text ?? "";

    return {
      source: "slack",
      channel_id: this.document.channel_id,
      thread_ts: this.document.thread_ts,
      message_ts: message.ts,
      edited_ts: editedTs,
      version: editedTs === null ? 1 : 2,
      permalink: message.permalink ?? null,
      ledger_ref: this.document.ledger_ref,
      intake_kind: this.intakeKind(text, fileRefs),
      file_refs: fileRefs,
      text_excerpt: null,
      sensitive_review: this.sensitiveReview(text, fileRefs),
      classification_status: "unclassified",
      dedup_key: `slack:${this.document.channel_id}:${this.document.thread_ts}:${message.ts}`,
      recorded_at: new Date().toISOString(),
      recorded_by: "gyeoljae-shadow",
      shadow_source_text: text,
    };
  }

  private fileRef(file: SlackFileRef): SlackFileRef {
    const ref: SlackFileRef = { id: file.id };
    if (file.name !== undefined) ref.name = file.name;
    if (file.mimetype !== undefined) ref.mimetype = file.mimetype;
    if (file.size !== undefined) ref.size = file.size;
    if (file.sha256 !== undefined) ref.sha256 = file.sha256;
    return ref;
  }

  private intakeKind(text: string, fileRefs: SlackFileRef[]): IntakeKind {
    if (BILLING_KIND_PATTERN.test(text)) return "billing-source";
    if (fileRefs.length > 0) return "file";
    return "message";
  }

  private sensitiveReview(text: string, fileRefs: SlackFileRef[]): boolean {
    if (fileRefs.length > 0) return true;
    return SENSITIVE_TEXT_PATTERN.test(text);
  }
}

/** Strips internal-only fields; the result is safe to persist or emit. */
export function publicEnvelope<T extends Envelope>(envelope: T): Omit<T, "shadow_source_text"> {
  const { shadow_source_text: _internal, ...rest } = envelope;
  return rest;
}
