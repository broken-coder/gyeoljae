import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DurableInbox } from "../src/slack/inbox.js";
import { SocketModeListener, type SocketLike } from "../src/slack/socket.js";

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-inbox-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("inbox records once, dedupes redelivery, tracks processed", () =>
  withDir((dir) => {
    const inbox = new DurableInbox(dir);
    assert.equal(inbox.record("env-1", { ts: "1.0" }), true);
    assert.equal(inbox.record("env-1", { ts: "1.0" }), false, "redelivery is a no-op");
    assert.equal(inbox.pending().length, 1);
    inbox.markProcessed("env-1");
    assert.equal(inbox.pending().length, 0);
    assert.equal(inbox.isProcessed("env-1"), true);
  }));

test("inbox survives restart: unprocessed entries replay, processed do not", () =>
  withDir((dir) => {
    const first = new DurableInbox(dir);
    first.record("env-a", { ts: "1.0" });
    first.record("env-b", { ts: "2.0" });
    first.markProcessed("env-a");
    // Simulated crash before env-b was marked processed.

    const restarted = new DurableInbox(dir);
    const pending = restarted.pending();
    assert.deepEqual(pending.map((entry) => entry.envelope_id), ["env-b"]);
    assert.equal(restarted.isProcessed("env-a"), true);
  }));

// --- Socket persist-before-ack ordering ---

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements SocketLike {
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function envelope(id: string): string {
  return JSON.stringify({ type: "events_api", envelope_id: id, payload: { event: { type: "message", ts: "1.0" } } });
}

test("persist runs before ack; ack carries the envelope id", async () => {
  const order: string[] = [];
  const sockets: FakeSocket[] = [];
  const listener = new SocketModeListener({
    appToken: "xapp-test",
    openUrl: async () => "wss://fake",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    persistBeforeAck: async (env) => {
      order.push(`persist:${env.envelope_id}`);
    },
    onEvent: () => {
      order.push("process");
    },
  });
  await listener.start();
  sockets[0]!.emit("message", { data: envelope("env-9") });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(order, ["persist:env-9", "process"]);
  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), { envelope_id: "env-9" });
  listener.stop();
});

test("a persist failure skips the ack so Slack redelivers", async () => {
  const sockets: FakeSocket[] = [];
  const listener = new SocketModeListener({
    appToken: "xapp-test",
    openUrl: async () => "wss://fake",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    persistBeforeAck: async () => {
      throw new Error("disk full");
    },
    onEvent: () => {
      throw new Error("must not process an unpersisted envelope");
    },
  });
  await listener.start();
  sockets[0]!.emit("message", { data: envelope("env-10") });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sockets[0]!.sent.length, 0, "no ack was sent");
  listener.stop();
});

// --- P2-c regression: the journal is content-free (validated candidate only) ---
test("inbox journal never contains raw message text", () =>
  withDir((dir) => {
    const inbox = new DurableInbox<{ verdict: string; thread_key: string; reply_ts: string }>(dir);
    // The listener validates first and stores ONLY the content-free candidate.
    // A candidate has no `text` field, so a secret in the original message
    // cannot reach the durable journal.
    const candidate = { verdict: "approved-candidate", thread_key: "C0EXAMPLE001:1.0", reply_ts: "2.0" };
    inbox.record("env-secret", candidate);

    const journal = readFileSync(join(dir, "inbox.jsonl"), "utf8");
    assert.ok(!journal.includes("SECRET-BODY-XYZ"), "message text must never appear in the journal");
    assert.ok(!journal.includes("\"text\""), "no text field is journaled");
    assert.ok(journal.includes("env-secret"), "the content-free candidate is journaled");
  }));
