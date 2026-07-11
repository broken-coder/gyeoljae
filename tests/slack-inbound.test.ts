import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Classifier } from "../src/classifier.js";
import { EnvelopeBuilder } from "../src/envelope.js";
import { SummaryRenderer } from "../src/renderer.js";
import { readTokenFile } from "../src/slack/token.js";
import { ThreadDocumentBuilder, groupThreads } from "../src/slack/thread-document.js";
import type { SlackApiMessage } from "../src/slack/client.js";

const API_MESSAGES: SlackApiMessage[] = [
  { ts: "1700000000.000100", text: "parent message", user: "UEXAMPLE", reply_count: 0 },
  {
    ts: "1700000060.000200",
    text: "invoice attachment",
    user: "UEXAMPLE",
    edited: { ts: "1700000120.000000" },
    files: [
      {
        id: "FEXAMPLE",
        name: "invoice_redacted.pdf",
        mimetype: "application/pdf",
        size: 2048,
        // deliberately extra field that must not pass through:
        ...({ url_private: "https://files.example.com/secret" } as object),
      },
    ],
  },
];

test("token file accepts raw and nested-JSON tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-"));
  try {
    const raw = join(dir, "raw");
    writeFileSync(raw, "xoxb-test\n");
    assert.equal(readTokenFile(raw), "xoxb-test");

    const nested = join(dir, "nested.json");
    writeFileSync(nested, JSON.stringify({ slack: { accounts: [{ botToken: "xoxb-fake" }] } }));
    assert.equal(readTokenFile(nested), "xoxb-fake");

    const app = join(dir, "app");
    writeFileSync(app, "xapp-1-test\n");
    assert.equal(readTokenFile(app, "xapp-"), "xapp-1-test");
    assert.throws(() => readTokenFile(app), /Unsupported token file format/);

    const bad = join(dir, "bad");
    writeFileSync(bad, "not-a-token");
    assert.throws(() => readTokenFile(bad), /Unsupported token file format/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thread document builder drops private URLs and keeps metadata", () => {
  const document = new ThreadDocumentBuilder("C0EXAMPLE001", "EX-1").build("1700000000.000100", API_MESSAGES);

  assert.equal(document.messages.length, 2);
  assert.ok(!JSON.stringify(document).includes("url_private"));
  assert.deepEqual(Object.keys(document.messages[1]!.files![0]!).sort(), ["id", "mimetype", "name", "size"]);
  assert.deepEqual(document.messages[1]!.edited, { ts: "1700000120.000000" });
});

test("groupThreads buckets by thread root, newest first", () => {
  const messages: SlackApiMessage[] = [
    { ts: "100.000001" },
    { ts: "300.000001" },
    { ts: "100.000002", thread_ts: "100.000001" },
  ];
  const grouped = groupThreads(messages);

  assert.deepEqual([...grouped.keys()], ["300.000001", "100.000001"]);
  assert.equal(grouped.get("100.000001")!.length, 2);
});

test("end-to-end: API messages classify agent-required with null excerpts", () => {
  const document = new ThreadDocumentBuilder("C0EXAMPLE001", "EX-1").build("1700000000.000100", API_MESSAGES);
  const classified = new Classifier(new EnvelopeBuilder(document).build()).classify();

  assert.equal(classified[1]!.classification_status, "agent-required");
  assert.ok(classified.every((envelope) => envelope.text_excerpt === null));
});

test("summary renderer handles empty and nonempty sets, content-free", () => {
  const empty = new SummaryRenderer([]).render();
  assert.match(empty, /No new intake recorded/);

  const document = new ThreadDocumentBuilder("C0EXAMPLE001", "EX-1").build("1700000000.000100", API_MESSAGES);
  const classified = new Classifier(new EnvelopeBuilder(document).build()).classify();
  const rendered = new SummaryRenderer(classified).render();

  assert.match(rendered, /Ledger ref: EX-1/);
  assert.match(rendered, /Action class: .*agent-required/);
  assert.ok(!rendered.includes("invoice attachment"), "message content must not appear in ledger comments");
});
