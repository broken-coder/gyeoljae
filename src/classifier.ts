import type { ActionClass, ClassificationStatus, ClassifiedEnvelope, Envelope } from "./types.js";

const APPROVAL_PATTERN = /승인:|approved|approval/i;
const AGENT_FILE_MIME_PREFIXES = ["application/pdf", "image/"];

/**
 * Classifies envelopes into routine vs agent-required intake.
 *
 * Deterministic by design: the bridge never judges content, it routes.
 * Anything ambiguous lands on needs-human rather than proceeding.
 */
export class Classifier {
  constructor(private readonly envelopes: Envelope[]) {}

  classify(): ClassifiedEnvelope[] {
    return this.envelopes.map((envelope) => {
      const classification_status = this.status(envelope);
      return {
        ...envelope,
        classification_status,
        action_class: this.actionClass(classification_status, envelope),
      };
    });
  }

  private status(envelope: Envelope): ClassificationStatus {
    if (this.agentRequired(envelope)) return "agent-required";
    if (this.isApproval(envelope)) return "routine";
    return "needs-human";
  }

  private actionClass(status: ClassificationStatus, envelope: Envelope): ActionClass {
    switch (status) {
      case "agent-required":
        return "agent-required";
      case "routine":
        return this.isApproval(envelope) ? "record-approval-only" : "routine-update";
      default:
        return "needs-human";
    }
  }

  private agentRequired(envelope: Envelope): boolean {
    if (!envelope.sensitive_review) return false;
    return envelope.file_refs.some((file) =>
      AGENT_FILE_MIME_PREFIXES.some((prefix) => (file.mimetype ?? "").startsWith(prefix)),
    );
  }

  private isApproval(envelope: Envelope): boolean {
    return APPROVAL_PATTERN.test(envelope.shadow_source_text ?? "");
  }
}
