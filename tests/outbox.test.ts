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

// --- Re-scan P1-a completion: independent drain of crashed passes ---

test("drain: a done event crashed mid-post (sending) is retried even with no items", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    const doneEvent = { ...EVENT, event_key: "EX-9:done:p1:watcher", kind: "done" as const };
    const crashed = new Outbox(outboxPath);
    crashed.markSending(doneEvent.event_key, doneEvent); // post never confirmed

    const chat = new CountingChat();
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox: new Outbox(outboxPath) });

    // The item is closed now — no pass will ever rebuild its event.
    const drained = await notifier.drain();
    assert.equal(drained.length, 1);
    assert.equal(chat.posts, 1, "resent (at-least-once without reconcile)");
    assert.equal(new Outbox(outboxPath).get(doneEvent.event_key), "sent");
  }));

test("drain: sending leftovers reconcile without resending; pending leftovers post", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    const sending = { ...EVENT, event_key: "EX-9:done:watcher" };
    const pending = { ...EVENT, event_key: "EX-10:approval-needed:p2" };
    const crashed = new Outbox(outboxPath);
    crashed.markSending(sending.event_key, sending);
    crashed.markPending(pending.event_key, pending); // crash after enqueue, before transition/post

    const chat = new CountingChat();
    const landed = { channel: "C0EXAMPLE009", ts: "1700000900.000001" };
    const outbox = new Outbox(outboxPath);
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), {
      outbox,
      reconcile: async (event) => (event.event_key === sending.event_key ? landed : null),
    });

    const drained = await notifier.drain(() => true); // caller confirms the pending transition landed
    assert.equal(drained.length, 2);
    assert.equal(chat.posts, 1, "only the pending one posts; sending reconciled");
    assert.deepEqual(outbox.receipt(sending.event_key), landed);
    assert.equal(outbox.get(pending.event_key), "sent");
  }));

test("drain: crash after enqueue but before send survives restart; sent is final", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    new Outbox(outboxPath).markPending(EVENT.event_key, EVENT); // process dies here

    const chat = new CountingChat();
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox: new Outbox(outboxPath) });
    await notifier.drain(() => true);
    assert.equal(chat.posts, 1);

    // markPending never regresses a sent record; a second drain is a no-op.
    const again = new Outbox(outboxPath);
    again.markPending(EVENT.event_key, EVENT);
    assert.equal(again.get(EVENT.event_key), "sent");
    const notifier2 = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox: again });
    assert.equal((await notifier2.drain(() => true)).length, 0);
    assert.equal(chat.posts, 1);
  }));

// --- Review fix: pending must never send unconfirmed (false-Done protection) ---

test("drain: pending without confirmation is skipped; unconfirmed pending is dropped", () =>
  withDir(async (dir) => {
    const outboxPath = join(dir, "outbox.json");
    const doneEvent = { ...EVENT, event_key: "EX-1:done:watcher", kind: "done" as const };
    new Outbox(outboxPath).markPending(doneEvent.event_key, doneEvent);

    const chat = new CountingChat();
    const outbox = new Outbox(outboxPath);
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox });

    // No callback: ambiguous — never send, never drop.
    assert.equal((await notifier.drain()).length, 0);
    assert.equal(chat.posts, 0);
    assert.equal(outbox.get(doneEvent.event_key), "pending");

    // Caller says the transition did NOT land: drop, never post a false Done.
    assert.equal((await notifier.drain(() => false)).length, 0);
    assert.equal(chat.posts, 0);
    assert.equal(outbox.get(doneEvent.event_key), undefined, "dropped; the item flow owns the retry");
  }));
