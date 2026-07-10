import type { ClassifiedEnvelope } from "./types.js";

const SHADOW_NOTE =
  "Shadow note: this payload is generated locally only; no ledger write, chat write, agent execution, or repo mutation is performed by the shadow package.";

/**
 * Renders a ledger-comment payload from classified envelopes.
 * Refs, counts, and statuses only — never message content.
 */
export class SummaryRenderer {
  constructor(private readonly envelopes: ClassifiedEnvelope[]) {}

  render(): string {
    if (this.envelopes.length === 0) {
      return [
        "No new intake recorded",
        "",
        "Envelope count: 0",
        "Text excerpt: omitted in shadow mode",
        "",
        SHADOW_NOTE,
      ].join("\n");
    }

    const first = this.envelopes[0]!;
    const ledgerRef = this.envelopes.map((envelope) => envelope.ledger_ref).find((ref) => ref) ?? "unmapped";
    const actionClasses = [...new Set(this.envelopes.map((envelope) => envelope.action_class))].sort();
    const sensitive = this.envelopes.some((envelope) => envelope.sensitive_review);
    const fileCount = this.envelopes.reduce((sum, envelope) => sum + envelope.file_refs.length, 0);
    const permalink = this.envelopes.map((envelope) => envelope.permalink).find((link) => link);

    const lines = [
      "Intake recorded",
      "",
      `Ledger ref: ${ledgerRef}`,
      `Source: ${first.source}`,
      `Thread: ${first.channel_id}/${first.thread_ts}`,
    ];
    if (permalink) lines.push(`Permalink: ${permalink}`);
    lines.push(
      `Action class: ${actionClasses.join(", ")}`,
      `Sensitive review: ${sensitive}`,
      `Envelope count: ${this.envelopes.length}`,
      `File ref count: ${fileCount}`,
      "Text excerpt: omitted in shadow mode",
      "",
      SHADOW_NOTE,
    );
    return lines.join("\n");
  }
}
