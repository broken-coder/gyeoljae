import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowlistAuthorizer,
  threadKey,
  validateApprovalReply,
  type PendingRequest,
  type ValidateOptions,
} from "../src/approval/validator.js";

// Golden cases modeled on the shadow-pilot evidence, with generic ids.
const PENDING = new Map<string, PendingRequest>([
  [threadKey("C0EXAMPLE001", "1700000000.000100"), { thread_key: "C0EXAMPLE001:1700000000.000100", ledger_ref: "EX-56" }],
]);

// An authorized approver is required for any approved-candidate.
const AUTHZ: ValidateOptions = { authorizer: allowlistAuthorizer(["UAPPROVER"]) };

function reply(text: string, overrides: Partial<{ thread_ts: string; channel_id: string; user: string }> = {}) {
  return {
    channel_id: overrides.channel_id ?? "C0EXAMPLE001",
    thread_ts: overrides.thread_ts ?? "1700000000.000100",
    ts: "1700000100.000001",
    user: overrides.user ?? "UAPPROVER",
    text,
  };
}

test("exact short approval from an authorized approver is an approved candidate", () => {
  for (const text of ["승인", " 동의 ", "진행", "Approved"]) {
    const result = validateApprovalReply(reply(text), PENDING, AUTHZ);
    assert.equal(result.verdict, "approved-candidate", text);
    assert.equal(result.ledger_ref, "EX-56");
  }
});

test("long form with matching ref approves; mismatched ref needs a human", () => {
  assert.equal(validateApprovalReply(reply("승인: EX-56"), PENDING, AUTHZ).verdict, "approved-candidate");
  const mismatch = validateApprovalReply(reply("승인: EX-99"), PENDING, AUTHZ);
  assert.equal(mismatch.verdict, "needs-human");
  assert.equal(mismatch.reason, "long-form-ref-mismatch");
});

test("scope-widening or conditional replies are never auto-approved", () => {
  for (const text of [
    "승인, 대신 범위를 전체 채널로 넓혀줘",
    "좋아 그런데 조건이 있어",
    "승인하는데 EXAMPLE-ROLE 말고 다른 것도 처리해줘",
  ]) {
    const result = validateApprovalReply(reply(text), PENDING, AUTHZ);
    assert.equal(result.verdict, "needs-human", text);
    assert.equal(result.reason, "modified-or-widened-reply");
  }
});

test("replies outside a request thread are not approvals", () => {
  assert.equal(validateApprovalReply(reply("승인", { thread_ts: "9999.000001" }), PENDING, AUTHZ).verdict, "not-approval");
  const noThread = validateApprovalReply(
    { channel_id: "C0EXAMPLE001", ts: "1700000100.000002", text: "승인", user: "UAPPROVER" },
    PENDING,
    AUTHZ,
  );
  assert.equal(noThread.verdict, "not-approval");
  assert.equal(noThread.reason, "not-in-thread");
});

test("candidate output is content-free", () => {
  const result = validateApprovalReply(reply("승인, 대신 범위를 전체 채널로 넓혀줘"), PENDING, AUTHZ);
  assert.ok(!JSON.stringify(result).includes("범위를 전체"), "reply text must never appear in the output");
});

// --- fail-closed authorization (HOM-72 item 1) ---

test("fail-closed: no authorizer configured never approves", () => {
  const result = validateApprovalReply(reply("승인"), PENDING);
  assert.equal(result.verdict, "needs-human");
  assert.equal(result.reason, "authorization-not-configured");
});

test("fail-closed: unauthorized user never approves", () => {
  const result = validateApprovalReply(reply("승인", { user: "USTRANGER" }), PENDING, AUTHZ);
  assert.equal(result.verdict, "needs-human");
  assert.equal(result.reason, "unauthorized-approver");
  assert.equal(result.approver, "USTRANGER", "approver id is still recorded for audit");
});

test("fail-closed: missing user identity never approves", () => {
  const result = validateApprovalReply(
    { channel_id: "C0EXAMPLE001", thread_ts: "1700000000.000100", ts: "1700000100.000009", text: "승인" },
    PENDING,
    AUTHZ,
  );
  assert.equal(result.verdict, "needs-human");
  assert.equal(result.reason, "missing-approver-identity");
});

test("fail-closed: bot or system messages are rejected before anything else", () => {
  const bot = validateApprovalReply({ ...reply("승인"), bot_id: "B0EXAMPLE" }, PENDING, AUTHZ);
  assert.equal(bot.verdict, "not-approval");
  assert.equal(bot.reason, "bot-or-system-message");

  const system = validateApprovalReply({ ...reply("승인"), subtype: "channel_join" }, PENDING, AUTHZ);
  assert.equal(system.verdict, "not-approval");
  assert.equal(system.reason, "bot-or-system-message");
});

test("short-approval phrases are configurable (drop ambiguous defaults)", () => {
  const strict: ValidateOptions = { authorizer: allowlistAuthorizer(["UAPPROVER"]), shortApprovals: ["승인", "approve"] };
  assert.equal(validateApprovalReply(reply("승인"), PENDING, strict).verdict, "approved-candidate");
  // "네"/"a" are no longer accepted phrases → treated as a non-approval reply.
  const dropped = validateApprovalReply(reply("네"), PENDING, strict);
  assert.equal(dropped.verdict, "needs-human");
  assert.equal(dropped.reason, "modified-or-widened-reply");
});
