import assert from "node:assert/strict";
import { test } from "node:test";

import { threadKey, validateApprovalReply, type PendingRequest } from "../src/approval/validator.js";

// Golden cases modeled on the shadow-pilot evidence, with generic ids.
const PENDING = new Map<string, PendingRequest>([
  [threadKey("C0EXAMPLE001", "1700000000.000100"), { thread_key: "C0EXAMPLE001:1700000000.000100", ledger_ref: "EX-56" }],
]);

function reply(text: string, overrides: Partial<{ thread_ts: string; channel_id: string }> = {}) {
  return {
    channel_id: overrides.channel_id ?? "C0EXAMPLE001",
    thread_ts: overrides.thread_ts ?? "1700000000.000100",
    ts: "1700000100.000001",
    user: "UAPPROVER",
    text,
  };
}

test("exact short approval in the request thread is an approved candidate", () => {
  for (const text of ["승인", " 동의 ", "진행", "Approved"]) {
    const result = validateApprovalReply(reply(text), PENDING);
    assert.equal(result.verdict, "approved-candidate", text);
    assert.equal(result.ledger_ref, "EX-56");
  }
});

test("long form with matching ref approves; mismatched ref needs a human", () => {
  assert.equal(validateApprovalReply(reply("승인: EX-56"), PENDING).verdict, "approved-candidate");
  const mismatch = validateApprovalReply(reply("승인: EX-99"), PENDING);
  assert.equal(mismatch.verdict, "needs-human");
  assert.equal(mismatch.reason, "long-form-ref-mismatch");
});

test("scope-widening or conditional replies are never auto-approved", () => {
  for (const text of [
    "승인, 대신 범위를 전체 채널로 넓혀줘",
    "좋아 그런데 조건이 있어",
    "승인하는데 EXAMPLE-ROLE 말고 다른 것도 처리해줘",
  ]) {
    const result = validateApprovalReply(reply(text), PENDING);
    assert.equal(result.verdict, "needs-human", text);
    assert.equal(result.reason, "modified-or-widened-reply");
  }
});

test("replies outside a request thread are not approvals", () => {
  assert.equal(validateApprovalReply(reply("승인", { thread_ts: "9999.000001" }), PENDING).verdict, "not-approval");
  const noThread = validateApprovalReply(
    { channel_id: "C0EXAMPLE001", ts: "1700000100.000002", text: "승인" },
    PENDING,
  );
  assert.equal(noThread.verdict, "not-approval");
  assert.equal(noThread.reason, "not-in-thread");
});

test("candidate output is content-free", () => {
  const result = validateApprovalReply(reply("승인, 대신 범위를 전체 채널로 넓혀줘"), PENDING);
  assert.ok(!JSON.stringify(result).includes("범위를 전체"), "reply text must never appear in the output");
});
