import assert from "node:assert/strict";
import { test } from "node:test";

import { EnvelopeBuilder } from "../src/envelope.js";
import { Pipeline, Scanner } from "../src/redaction/pipeline.js";
import type { ThreadDocument } from "../src/types.js";

const FIXED_SECRET = "0".repeat(64);

function pipeline(): Pipeline {
  return new Pipeline({ tokenSecret: FIXED_SECRET });
}

test("scanner finds synthetic email and phone with correct spans", () => {
  const text = "Contact synthetic.user@example.com or 010-1234-5678 for the test case.";
  const findings = new Scanner().scan(text);

  assert.deepEqual(
    findings.map((finding) => finding.subtype),
    ["email", "phone"],
  );
  const email = findings[0]!;
  assert.equal(text.slice(email.start_offset, email.end_offset), "synthetic.user@example.com");
});

test("redaction replaces values with deterministic category tokens", () => {
  const result = pipeline().syntheticRedact("mail synthetic.user@example.com now", "slack-abc123");

  assert.match(result.redacted_text, /^mail \{\{PII:email:[0-9a-f]{12}\}\} now$/);
  const again = pipeline().syntheticRedact("mail synthetic.user@example.com now", "slack-abc123");
  assert.equal(result.redacted_text, again.redacted_text, "same secret must yield the same token");
});

test("manifest describes findings without leaking values, with action hints", () => {
  const result = pipeline().syntheticRedact(
    "key api_key=SYNTHETICSYNTHETIC1234 mail synthetic.user@example.com",
    "slack-abc123",
  );

  const serialized = JSON.stringify(result.manifest);
  assert.ok(!serialized.includes("SYNTHETICSYNTHETIC1234"));
  assert.ok(!serialized.includes("synthetic.user@example.com"));

  const hints = new Map(result.manifest.tokens.map((token) => [token.subtype, token.action_hint]));
  assert.equal(hints.get("api-key"), "rotate-or-quarantine");
  assert.equal(hints.get("email"), "quarantine");
  assert.ok(result.manifest.tokens.every((token) => token.quarantine_ref.startsWith("secretref://synthetic-quarantine/slack-abc123/")));
});

test("overlapping findings keep the earliest longest match", () => {
  // kr-rrn pattern overlaps the phone pattern; earliest-longest wins, no double redaction
  const result = pipeline().syntheticRedact("rrn 900101-1234567 end", "slack-abc123");

  assert.equal(result.findings.length, 1);
  assert.equal(result.redacted_text.match(/\{\{/g)!.length, 1);
});

test("clean text passes through untouched", () => {
  const result = pipeline().syntheticRedact("nothing sensitive here", "slack-abc123");

  assert.equal(result.redacted_text, "nothing sensitive here");
  assert.deepEqual(result.findings, []);
});

test("source id is validated", () => {
  assert.throws(() => pipeline().syntheticRedact("text", "../escape"), /source_id/);
});

test("envelope carries redaction fields; source text never in redacted output", () => {
  const document: ThreadDocument = {
    ledger_ref: "EX-1",
    channel_id: "C0EXAMPLE001",
    thread_ts: "1700000000.000100",
    messages: [{ ts: "1700000000.000100", text: "reach synthetic.user@example.com" }],
  };
  const [envelope] = new EnvelopeBuilder(document, { redactionPipeline: pipeline() }).build();

  assert.equal(envelope!.redaction_status, "redacted");
  assert.ok(!envelope!.redacted_text.includes("synthetic.user@example.com"));
  assert.match(envelope!.redaction_manifest.source_id, /^slack-[0-9a-f]{12}$/);

  const clean: ThreadDocument = { ...document, messages: [{ ts: "1700000060.000200", text: "hello" }] };
  const [cleanEnvelope] = new EnvelopeBuilder(clean, { redactionPipeline: pipeline() }).build();
  assert.equal(cleanEnvelope!.redaction_status, "clean");
});
