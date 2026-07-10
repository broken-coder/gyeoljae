import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EnvelopeBuilder } from "../src/envelope.js";
import { ReplayPlanner, compareTs } from "../src/replay.js";
import { ShadowStore } from "../src/store.js";
import type { ThreadDocument, ThreadMessage } from "../src/types.js";

function thread(): ThreadDocument {
  return {
    ledger_ref: "EX-1",
    channel_id: "C0EXAMPLE001",
    thread_ts: "1700000000.000100",
    messages: [
      { ts: "1700000000.000100", text: "parent" },
      { ts: "1700000060.000200", text: "reply" },
    ],
  };
}

function withStore(run: (store: ShadowStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-"));
  try {
    run(new ShadowStore(join(dir, "store.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("replay planner returns only messages after last ack, sorted", () => {
  const messages: ThreadMessage[] = [
    { ts: "1700000060.000200" },
    { ts: "1700000000.000100" },
    { ts: "1700000120.000300" },
  ];
  const replay = new ReplayPlanner(messages, "1700000000.000100").replayMessages();

  assert.deepEqual(
    replay.map((message) => message.ts),
    ["1700000060.000200", "1700000120.000300"],
  );
});

test("compareTs compares as integer tuples, not strings", () => {
  assert.ok(compareTs("1700000000.000100", "1700000000.000090") > 0);
  assert.ok(compareTs("999.000001", "1000.000000") < 0);
});

test("upsert is idempotent on dedup_key", () => {
  withStore((store) => {
    const envelopes = new EnvelopeBuilder(thread()).build();
    for (const envelope of [...envelopes, ...envelopes, ...envelopes]) store.upsert(envelope);

    assert.equal(store.records().length, 2);
  });
});

test("upsert strips internal source text before persisting", () => {
  withStore((store) => {
    const [envelope] = new EnvelopeBuilder(thread()).build();
    store.upsert(envelope!);

    assert.ok(store.records().every((record) => !("shadow_source_text" in record)));
  });
});

test("edit increments version once; same edit is stable", () => {
  withStore((store) => {
    const [envelope] = new EnvelopeBuilder(thread()).build();
    store.upsert(envelope!);

    const edited = { ...envelope!, edited_ts: "1700000200.000000" };
    store.upsert(edited);
    assert.equal(store.records()[0]!.version, 2);

    store.upsert(edited); // same edited_ts replayed
    assert.equal(store.records()[0]!.version, 2);

    store.upsert({ ...envelope!, edited_ts: "1700000300.000000" }); // second edit
    assert.equal(store.records()[0]!.version, 3);
  });
});

test("records stay sorted by message_ts", () => {
  withStore((store) => {
    const envelopes = new EnvelopeBuilder(thread()).build();
    store.upsert(envelopes[1]!);
    store.upsert(envelopes[0]!);

    assert.deepEqual(
      store.records().map((record) => record.message_ts),
      ["1700000000.000100", "1700000060.000200"],
    );
  });
});
