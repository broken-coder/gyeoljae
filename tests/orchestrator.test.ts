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

  assert.deepEqual(summary, { blocked: 1, done: 0, approvals: 0, notified: 1, stale_rejected: 0 });
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

  assert.deepEqual(summary, { blocked: 0, done: 0, approvals: 0, notified: 0, stale_rejected: 0 });
  assert.deepEqual(control.transitions, []);
});

test("done marker wins over request marker; closed items skipped", async () => {
  const { control, orchestrator } = rig();
  const summary = await orchestrator.pass([
    requestItem({ comment_bodies: ["## Approval requested\n...", "## 완료\n\n완주"] }),
    requestItem({ ref: "EX-1", status: "done", comment_bodies: ["## Approval requested\n..."] }),
  ]);

  assert.deepEqual(summary, { blocked: 0, done: 1, approvals: 0, notified: 1, stale_rejected: 0 });
  assert.deepEqual(control.transitions, [{ ref: "EX-64", to: "done" }]);
});

test("approved candidate is deduplicated and recorded only for known refs", async () => {
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

  assert.deepEqual(first, { blocked: 0, done: 1, approvals: 0, notified: 1, stale_rejected: 0 });
  assert.deepEqual(second, { blocked: 0, done: 0, approvals: 0, notified: 0, stale_rejected: 0 });
});

test("record-time digest mismatch rejects a stale approval without recording", async () => {
  const { control, orchestrator } = rig();
  const candidate = {
    verdict: "approved-candidate" as const,
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    reply_ts: "1700000700.000001",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread" as const,
    proposal_digest: "digest-at-notification",
  };
  // Live item now carries a different proposal digest (proposal edited since notification).
  const item = requestItem({ status: "blocked", proposal_digest: "digest-changed" });

  const summary = await orchestrator.pass([item], [candidate]);
  assert.equal(summary.stale_rejected, 1);
  assert.equal(summary.approvals, 0);
  assert.deepEqual(control.approvals, []);

  // Consumed once: a rerun does not retry it.
  const rerun = await orchestrator.pass([item], [candidate]);
  assert.equal(rerun.stale_rejected, 0);
});

test("matching digest records normally; absent digests fall back to prior behavior", async () => {
  const { control, orchestrator } = rig();
  const matching = {
    verdict: "approved-candidate" as const,
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    reply_ts: "1700000700.000003",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread" as const,
    proposal_digest: "same-digest",
  };
  const summary = await orchestrator.pass(
    [requestItem({ status: "blocked", proposal_digest: "same-digest" })],
    [matching],
  );
  assert.equal(summary.approvals, 1);
  assert.deepEqual(control.approvals, [{ ref: "EX-64", reply_ts: "1700000700.000003" }]);
});

test("second proposal cycle on the same item re-notifies (event-identity keys)", async () => {
  const { orchestrator, notifier } = rig();

  // Cycle 1: proposal p1 on EX-64.
  const c1 = await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "p1" })]);
  assert.equal(c1.notified, 1);

  // Same proposal p1 again → deduped, no new notification.
  const same = await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "p1" })]);
  assert.equal(same.notified, 0);

  // Cycle 2: a NEW proposal p2 on the same item → must notify again.
  const c2 = await orchestrator.pass([requestItem({ status: "open", proposal_id: "p2" })]);
  assert.equal(c2.notified, 1, "a distinct proposal cycle is not suppressed as a duplicate");
  assert.equal(c2.blocked, 1, "and re-blocks the item for the new cycle");

  assert.equal(notifier.delivered.length, 2);
});

test("without proposal identity, keys stay ref-only (prior behavior preserved)", async () => {
  const { orchestrator } = rig();
  const first = await orchestrator.pass([requestItem()]);
  const again = await orchestrator.pass([requestItem({ status: "blocked" })]);
  assert.equal(first.notified, 1);
  assert.equal(again.notified, 0, "ref-only key suppresses the repeat, as before");
});

test("record-time: same digest but different proposal_id is stale (P2-b)", async () => {
  const { control, orchestrator } = rig();
  const candidate = {
    verdict: "approved-candidate" as const,
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    reply_ts: "1700000700.000010",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread" as const,
    proposal_id: "p1",
    proposal_digest: "d",
    version: 1,
  };
  // Live item: same digest, but a different proposal id/version (a new proposal).
  const item = requestItem({ status: "blocked", proposal_id: "p2", proposal_digest: "d", version: 2 });

  const summary = await orchestrator.pass([item], [candidate]);
  assert.equal(summary.stale_rejected, 1);
  assert.equal(summary.approvals, 0);
  assert.deepEqual(control.approvals, []);
});

test("cycleKey: editing a proposal (same id, new digest) re-notifies", async () => {
  const { orchestrator, notifier } = rig();
  const first = await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "p1", proposal_digest: "d1" })]);
  assert.equal(first.notified, 1);
  // Same id, edited body → new digest → new cycle key → re-notify.
  const edited = await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "p1", proposal_digest: "d2" })]);
  assert.equal(edited.notified, 1, "edited proposal re-notifies");
  assert.equal(notifier.delivered.length, 2);
});

test("strictIdentity: a candidate without proposal identity is rejected", async () => {
  const control = new FakeControl();
  const orchestrator = new WatchOrchestrator(control, new FakeNotifier(), new MemoryState(), { strictIdentity: true });
  const candidate = {
    verdict: "approved-candidate" as const,
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    reply_ts: "1700000700.000011",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread" as const,
  };
  const summary = await orchestrator.pass(
    [requestItem({ status: "blocked", proposal_id: "p1", proposal_digest: "d1" })],
    [candidate],
  );
  assert.equal(summary.stale_rejected, 1);
  assert.deepEqual(control.approvals, []);
});

test("re-scan P1-a: crashed done notification is drained on the next (empty) pass", async () => {
  // Real Notifier + Outbox + a chat that fails once: pass 1 enqueues, transitions,
  // then the post crashes; pass 2 sees NO items (issue closed) yet still delivers.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Notifier } = await import("../src/notify/notifier.js");
  const { Outbox } = await import("../src/notify/outbox.js");

  const dir = mkdtempSync(join(tmpdir(), "drain-orch-"));
  try {
    const chat = {
      posts: 0,
      failNext: true,
      async notify(): Promise<unknown> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("chat down");
        }
        this.posts += 1;
        return { channel: "C0EXAMPLE009", ts: "1700000950.000001" };
      },
    };
    const control = new FakeControl();
    const state = new MemoryState();
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox: new Outbox(join(dir, "outbox.json")) });
    const orchestrator = new WatchOrchestrator(control, notifier, state);
    const doneItem = requestItem({ comment_bodies: ["## Approval requested\n...", "## 완료\n\n완주"] });

    await assert.rejects(orchestrator.pass([doneItem]), /chat down/);
    assert.deepEqual(control.transitions, [{ ref: "EX-64", to: "done" }], "transition landed before the crash");

    // Next pass: the item is closed and gone. The drain still delivers it.
    const recovery = await orchestrator.pass([]);
    assert.equal(recovery.notified, 1);
    assert.equal(chat.posts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-scan nit: field-tagged cycle identity cannot collide across tuples", async () => {
  const { orchestrator, notifier } = rig();
  await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "a:b" })]);
  await orchestrator.pass([requestItem({ status: "blocked", proposal_id: "a", proposal_digest: "b" })]);
  assert.equal(notifier.delivered.length, 2, "distinct tuples get distinct cycles");
});

test("review fix P1: a failed done transition never yields a false Done notification", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Notifier } = await import("../src/notify/notifier.js");
  const { Outbox } = await import("../src/notify/outbox.js");

  const dir = mkdtempSync(join(tmpdir(), "false-done-"));
  try {
    const chat = { posts: 0, async notify(): Promise<unknown> { this.posts += 1; return { ts: "1.0" }; } };
    let failTransitions = 2;
    const control = {
      transitions: 0,
      async transition(): Promise<void> {
        if (failTransitions > 0) { failTransitions -= 1; throw new Error("ledger down"); }
        this.transitions += 1;
      },
      async recordApproval(): Promise<void> {},
    };
    const notifier = new Notifier(chat, "#ex", join(dir, "state.json"), { outbox: new Outbox(join(dir, "outbox.json")) });
    const orchestrator = new WatchOrchestrator(control, notifier, new MemoryState());
    const doneItem = requestItem({ comment_bodies: ["## Approval requested\n...", "## 완료\n\n완주"] });

    // Pass 1: enqueue lands, transition FAILS. The item stays open.
    await assert.rejects(orchestrator.pass([doneItem]), /ledger down/);
    assert.equal(chat.posts, 0);

    // Pass 2: the item is STILL OPEN — the drained pending must be dropped,
    // not posted ("✅ Done" for an open item is the reviewer's repro).
    // The item flow retries the transition, which fails again.
    await assert.rejects(orchestrator.pass([doneItem]), /ledger down/);
    assert.equal(chat.posts, 0, "no false Done while the item is open");

    // Pass 3: ledger recovers — transition lands, then exactly one notification.
    const recovered = await orchestrator.pass([doneItem]);
    assert.equal(control.transitions, 1);
    assert.equal(recovered.done, 1);
    assert.equal(recovered.notified, 1);
    assert.equal(chat.posts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review fix P2: strictIdentity enforces the full tuple's presence, both directions", async () => {
  const fullItem = requestItem({ status: "blocked", proposal_id: "p1", proposal_digest: "d1", version: 1 });
  const base = {
    verdict: "approved-candidate" as const,
    thread_key: "C0EXAMPLE009:1700000601.000001",
    ledger_ref: "EX-64",
    approver: "UAPPROVER",
    reason: "short-approval-in-request-thread" as const,
  };

  // Reviewer repro: candidate carries id only, live item carries id+digest+version.
  { const control = new FakeControl();
    const orchestrator = new WatchOrchestrator(control, new FakeNotifier(), new MemoryState(), { strictIdentity: true });
    const s = await orchestrator.pass([fullItem], [{ ...base, reply_ts: "1700000700.000021", proposal_id: "p1" }]);
    assert.equal(s.stale_rejected, 1);
    assert.deepEqual(control.approvals, []); }

  // Candidate carrying MORE identity than the item is rejected too.
  { const control = new FakeControl();
    const orchestrator = new WatchOrchestrator(control, new FakeNotifier(), new MemoryState(), { strictIdentity: true });
    const s = await orchestrator.pass(
      [requestItem({ status: "blocked", proposal_id: "p1" })],
      [{ ...base, reply_ts: "1700000700.000022", proposal_id: "p1", proposal_digest: "d1", version: 1 }],
    );
    assert.equal(s.stale_rejected, 1);
    assert.deepEqual(control.approvals, []); }

  // Full matching tuple still records.
  { const control = new FakeControl();
    const orchestrator = new WatchOrchestrator(control, new FakeNotifier(), new MemoryState(), { strictIdentity: true });
    const s = await orchestrator.pass([fullItem], [{ ...base, reply_ts: "1700000700.000023", proposal_id: "p1", proposal_digest: "d1", version: 1 }]);
    assert.equal(s.approvals, 1);
    assert.equal(control.approvals.length, 1); }
});
