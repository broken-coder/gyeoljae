import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Notifier, type LedgerEvent } from "../src/notify/notifier.js";
import { Outbox } from "../src/notify/outbox.js";
import type { ChatAdapter } from "../src/types.js";

const EVENT: LedgerEvent = {
  event_key: "EX-12:approval-needed",
  kind: "approval-needed",
  ledger_ref: "EX-12",
  title: "Rotate the example credential",
};

function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-outbox-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

class CountingChat implements ChatAdapter {
  posts = 0;
  failNext = false;
  async notify(_channel: string, _body: string): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("api timeout");
    }
    this.posts += 1;
    return { channel: "C0EXAMPLE009", ts: `1700000700.00000${this.posts}` };
  }
}

test("outbox delivery is exactly-once across passes and stores the receipt", () =>
  withDir(async (dir) => {
    const chat = new CountingChat();
    const outbox = new Outbox(join(dir, "outbox.json"));
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox });

    const first = await notifier.deliver([EVENT]);
    const second = await notifier.deliver([EVENT]);

    assert.equal(chat.posts, 1);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(outbox.get(EVENT.event_key), "sent");
    assert.deepEqual(outbox.receipt(EVENT.event_key), (first[0]!.receipt));
  }));

test("API timeout leaves the key in sending (not sent) and retries next pass", () =>
  withDir(async (dir) => {
    const chat = new CountingChat();
    const outbox = new Outbox(join(dir, "outbox.json"));
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox });

    chat.failNext = true;
    await assert.rejects(notifier.deliver([EVENT]));
    assert.equal(outbox.get(EVENT.event_key), "sending", "durable intent survived the failed post");

    // Next pass without a reconcile hook resends (at-least-once).
    const retry = await notifier.deliver([EVENT]);
    assert.equal(retry.length, 1);
    assert.equal(chat.posts, 1);
    assert.equal(outbox.get(EVENT.event_key), "sent");
  }));

test("post crash window: reconcile finds the landed post and does not resend", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    // Simulate a crash after the post landed but before markSent: key left "sending".
    const crashed = new Outbox(outboxPath);
    crashed.markSending(EVENT.event_key);

    const chat = new CountingChat();
    const outbox = new Outbox(outboxPath); // reload from disk, as a restart would
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), {
      outbox,
      reconcile: async () => ({ channel: "C0EXAMPLE009", ts: "1700000700.reconciled" }),
    });

    const delivered = await notifier.deliver([EVENT]);
    assert.equal(chat.posts, 0, "reconcile found the post; no duplicate sent");
    assert.equal(delivered.length, 1, "the reconciled event is surfaced for recovery");
    assert.equal(outbox.get(EVENT.event_key), "sent");
    assert.deepEqual(outbox.receipt(EVENT.event_key), { channel: "C0EXAMPLE009", ts: "1700000700.reconciled" });
  }));

test("post crash window: reconcile returns the receipt so recovery surfaces it", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    const crashed = new Outbox(outboxPath);
    crashed.markSending(EVENT.event_key); // posted, crashed before markSent

    const chat = new CountingChat();
    const outbox = new Outbox(outboxPath);
    const reconciledReceipt = { channel: "C0EXAMPLE009", ts: "1700000700.reconciled" };
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), {
      outbox,
      reconcile: async () => reconciledReceipt,
    });

    const delivered = await notifier.deliver([EVENT]);
    assert.equal(chat.posts, 0, "no duplicate post");
    assert.equal(delivered.length, 1, "recovery surfaces the event so onPendingThread can fire");
    assert.deepEqual(delivered[0]!.receipt, reconciledReceipt);
    assert.equal(outbox.get(EVENT.event_key), "sent");
  }));
