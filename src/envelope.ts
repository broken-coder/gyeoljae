import { createHash } from "node:crypto";

import { Pipeline } from "./redaction/pipeline.js";
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
  private readonly pipeline: Pipeline;

  constructor(
    private readonly document: ThreadDocument,
    options: { redactionPipeline?: Pipeline } = {},
  ) {
    this.pipeline = options.redactionPipeline ?? new Pipeline();
  }

  build(): Envelope[] {
    return this.document.messages.map((message) => this.envelopeFor(message));
  }

  private envelopeFor(message: ThreadMessage): Envelope {
    const fileRefs = (message.files ?? []).map((file) => this.fileRef(file));
    const editedTs = message.edited?.ts ?? null;
    const text = message.text ?? "";
    const dedupKey = `slack:${this.document.channel_id}:${this.document.thread_ts}:${message.ts}`;
    const redaction = this.pipeline.syntheticRedact(text, redactionSourceId(dedupKey));

    return {
      source: "slack",
      channel_id: this.document.channel_id,
      thread_ts: this.document.thread_ts,
      message_ts: message.ts,
      // Version counts edit states observed by the store (see ShadowStore.nextVersion);
      // the builder always emits 1 regardless of whether the message arrives pre-edited.
      edited_ts: editedTs,
      version: 1,
      permalink: message.permalink ?? null,
      ledger_ref: this.document.ledger_ref,
      intake_kind: this.intakeKind(text, fileRefs),
      file_refs: fileRefs,
      text_excerpt: null,
      sensitive_review: this.sensitiveReview(text, fileRefs),
      classification_status: "unclassified",
      dedup_key: dedupKey,
      recorded_at: new Date().toISOString(),
      recorded_by: "gyeoljae-shadow",
      redaction_status: redaction.findings.length === 0 ? "clean" : "redacted",
      redacted_text: redaction.redacted_text,
      redaction_manifest: redaction.manifest,
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

/** Matches the Ruby golden spec: "slack-" + first 12 hex chars of SHA256(dedup_key). */
function redactionSourceId(dedupKey: string): string {
  return `slack-${createHash("sha256").update(dedupKey).digest("hex").slice(0, 12)}`;
}

/** Strips internal-only fields; the result is safe to persist or emit. */
export function publicEnvelope<T extends Envelope>(envelope: T): Omit<T, "shadow_source_text"> {
  const { shadow_source_text: _internal, ...rest } = envelope;
  return rest;
}
