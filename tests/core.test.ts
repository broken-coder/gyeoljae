import assert from "node:assert/strict";
import { test } from "node:test";

import { Classifier } from "../src/classifier.js";
import { EnvelopeBuilder, publicEnvelope } from "../src/envelope.js";
import type { ThreadDocument } from "../src/types.js";

// Generic fixture mirroring the golden-spec Ruby tests (no real workspace identifiers).
function billingThread(): ThreadDocument {
  return {
    ledger_ref: "EX-28",
    channel_id: "C0EXAMPLE001",
    thread_ts: "1700000000.000100",
    messages: [
      {
        ts: "1700000000.000100",
        text: "EX-28 billing-source request",
        user: "UREQUESTER",
        permalink: "https://example.slack.com/archives/C0EXAMPLE001/p1700000000000100",
      },
      {
        ts: "1700000060.000200",
        text: "invoice attachment",
        user: "UREQUESTER",
        edited: { ts: "1700000120.000000" },
        files: [
          {
            id: "FEXAMPLEPDF",
            name: "invoice_redacted.pdf",
            mimetype: "application/pdf",
            size: 1024,
          },
        ],
      },
    ],
  };
}

test("shadow envelopes never include a text excerpt", () => {
  const envelopes = new EnvelopeBuilder(billingThread()).build();

  assert.equal(envelopes.length, 2);
  assert.ok(envelopes.every((envelope) => envelope.text_excerpt === null));
  assert.ok(envelopes.every((envelope) => envelope.source === "slack"));
});

test("dedup key uses channel, thread, and message ts", () => {
  const first = new EnvelopeBuilder(billingThread()).build()[0]!;

  assert.equal(first.dedup_key, "slack:C0EXAMPLE001:1700000000.000100:1700000000.000100");
});

test("file messages are sensitive-review with metadata-only refs", () => {
  const envelopes = new EnvelopeBuilder(billingThread()).build();
  const fileEnvelope = envelopes[1]!;

  assert.equal(fileEnvelope.sensitive_review, true);
  assert.deepEqual(Object.keys(fileEnvelope.file_refs[0]!).sort(), ["id", "mimetype", "name", "size"]);
});

test("edited message carries edited_ts; version stays 1 until the store observes an edit", () => {
  const envelopes = new EnvelopeBuilder(billingThread()).build();

  assert.equal(envelopes[1]!.edited_ts, "1700000120.000000");
  assert.equal(envelopes[1]!.version, 1);
});

test("billing file intake classifies agent-required", () => {
  const envelopes = new EnvelopeBuilder(billingThread()).build();
  const classified = new Classifier(envelopes).classify();

  const withFiles = classified.filter((envelope) => envelope.file_refs.length > 0);
  assert.ok(withFiles.length > 0);
  assert.ok(withFiles.every((envelope) => envelope.classification_status === "agent-required"));
});

test("scoped approval reply classifies routine record-approval-only", () => {
  const document: ThreadDocument = {
    ledger_ref: "EX-99",
    channel_id: "C0EXAMPLE002",
    thread_ts: "1700000300.000001",
    messages: [{ ts: "1700000300.000002", text: "승인: EX-99 범위: PR #1 ready" }],
  };
  const classified = new Classifier(new EnvelopeBuilder(document).build()).classify();

  assert.equal(classified[0]!.classification_status, "routine");
  assert.equal(classified[0]!.action_class, "record-approval-only");
});

test("publicEnvelope strips internal source text; redacted_text keeps clean content", () => {
  const envelope = new EnvelopeBuilder(billingThread()).build()[0]!;
  const sanitized = publicEnvelope(envelope);

  assert.ok(!("shadow_source_text" in sanitized));
  assert.ok(!("redacted_text" in sanitized), "redacted_text must never persist or emit");
  assert.equal(sanitized.redaction_status, "clean");
});
