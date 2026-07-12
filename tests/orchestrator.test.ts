import assert from "node:assert/strict";
import { test } from "node:test";

import type { CandidateApproval } from "../src/approval/validator.js";
import type { LedgerEvent } from "../src/notify/notifier.js";
import { WatchOrchestrator, type LedgerControl, type WatchItem } from "../src/watch/orchestrator.js";

/**
 * Golden spec: replays of the live round-trip sessions (request -> blocked ->
 * approval -> record -> 완료 -> done), including both live-caught defects as
 * regressions: quoted-marker false positives and duplicate reruns.
 */

class FakeControl implements LedgerControl {
  transitions: Array<{ ref: string; to: string }> = [];
  approvals: Array<{ ref: string; reply_ts: string }> = [];

  async transition(ref: string, to: "blocked" | "done"): Promise<void> {
    this.transitions.push({ ref, to });
  }

  async recordApproval(ref: string, candidate: CandidateApproval): Promise<void> {
    this.approvals.push({ ref, reply_ts: candidate.reply_ts });
  }
}

class FakeNotifier {
  seen = new Set<string>();
  delivered: string[] = [];

  async deliver(events: LedgerEvent[]): Promise<Array<{ event: LedgerEvent; receipt: unknown }>> {
    const out: Array<{ event: LedgerEvent; receipt: unknown }> = [];
    for (const event of events) {
      if (this.seen.has(event.event_key)) continue;
      this.seen.add(event.event_key);
      this.delivered.push(event.event_key);
      out.push({ event, receipt: { channel: "C0EXAMPLE009", ts: `${1700000600 + this.delivered.length}.000001` } });
    }
    return out;
  }
}

class MemoryState {
  private keys = new Set<string>();
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.add(key);
  }
}

function requestItem(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    ref: "EX-64",
    title: "round trip",
    status: "todo",
    comment_bodies: ["## Approval requested\n\n- **Target**: synthetic"],
    ...overrides,
  };
}

function rig() {
  const control = new FakeControl();
  const notifier = new FakeNotifier();
  const state = new MemoryState();
  const pending: Array<{ ref: string; receipt: unknown }> = [];
  const orchestrator = new WatchOrchestrator(control, notifier, state, {
    onPendingThread: (receipt, ref) => pending.push({ ref, receipt }),
  });
  return { control, notifier, state, pending, orchestrator };
}

test("request marker at comment start: blocked + notify + pending registration", async () => {
  const { control, pending, orchestrator } = rig();
  const summary = await orchestrator.pass([requestItem()]);

  assert.deepEqual(summary, { blocked: 1, done: 0, approvals: 0, notified: 1 });
  assert.deepEqual(control.transitions, [{ ref: "EX-64", to: "blocked" }]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.ref, "EX-64");
});

test("regression: quoted marker mid-comment never triggers", async () => {
  const { control, orchestrator } = rig();
  const summary = await orchestrator.pass([
    requestItem({
      comment_bodies: [
        "Scoped approval recorded... the standard form is '## Approval requested' + five fields.",
        "policy text quoting ## 완료 ownership as well",
      ],
    }),
  ]);

  assert.deepEqual(summary, { blocked: 0, done: 0, approvals: 0, notified: 0 });
  assert.deepEqual(control.transitions, []);
});

test("done marker wins over request marker; closed items skipped", async () => {
  const { control, orchestrator } = rig();
  const summary = await orchestrator.pass([
    requestItem({ comment_bodies: ["## Approval requested\n...", "## 완료\n\n완주"] }),
    requestItem({ ref: "EX-1", status: "done", comment_bodies: ["## Approval requested\n..."] }),
  ]);

  assert.deepEqual(summary, { blocked: 0, done: 1, approvals: 0, notified: 1 });
  assert.deepEqual(control.transitions, [{ ref: "EX-64", to: "done" }]);
});

test("approved candidate recorded exactly once, only for known refs", async () => {
  const { control, orchestrator } = rig();
  const candidate: CandidateApproval = {
    verdict: "approved-candidate",
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    reply_ts: "1700000700.000001",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread",
  };
  const unknownRef = { ...candidate, ledger_ref: "EX-999", reply_ts: "1700000700.000002" };

  await orchestrator.pass([requestItem()], [candidate, unknownRef]);
  const rerun = await orchestrator.pass([requestItem({ status: "blocked" })], [candidate]);

  assert.deepEqual(control.approvals, [{ ref: "EX-64", reply_ts: "1700000700.000001" }]);
  assert.equal(rerun.approvals, 0);
});

test("full idempotent rerun is all zeros", async () => {
  const { orchestrator } = rig();
  const items = [requestItem({ comment_bodies: ["## Approval requested\n...", "## 완료\n\n완주"] })];

  const first = await orchestrator.pass(items);
  const second = await orchestrator.pass([{ ...items[0]!, status: "done" }]);

  assert.deepEqual(first, { blocked: 0, done: 1, approvals: 0, notified: 1 });
  assert.deepEqual(second, { blocked: 0, done: 0, approvals: 0, notified: 0 });
});
