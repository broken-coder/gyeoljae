import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CandidateApproval } from "../src/approval/validator.js";
import { runListen } from "../src/cli/listen.js";

/**
 * End-to-end coverage of the listener CLI against the fail-closed
 * authorization contract (validator core; wired via --approvers-file).
 */

const THREAD = { channel: "C0EXAMPLE001", thread_ts: "1700000000.000100" };
const PENDING = [{ thread_key: "C0EXAMPLE001:1700000000.000100", ledger_ref: "EX-1" }];

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-listen-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function fixtureFile(dir: string, events: unknown[]): string {
  const path = join(dir, "fixture.json");
  writeFileSync(path, `${JSON.stringify({ pending: PENDING, events }, null, 2)}\n`);
  return path;
}

function recordedCandidates(outPath: string): CandidateApproval[] {
  if (!existsSync(outPath)) return [];
  return readFileSync(outPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CandidateApproval);
}

test("without an approvers file, a well-formed approval degrades to needs-human (fail closed)", () =>
  withDir(async (dir) => {
    const out = join(dir, "out.jsonl");
    const fixture = fixtureFile(dir, [
      { ...THREAD, ts: "1700000001.000100", user: "U0EXAMPLE001", text: "approve" },
    ]);

    await runListen(["--fixture", fixture, "--out", out]);

    const candidates = recordedCandidates(out);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.verdict, "needs-human");
    assert.equal(candidates[0]!.reason, "authorization-not-configured");
  }));

test("allowlisted approver produces an approved-candidate; unlisted degrades with a distinct reason", () =>
  withDir(async (dir) => {
    const out = join(dir, "out.jsonl");
    const approvers = join(dir, "approvers.json");
    writeFileSync(approvers, `${JSON.stringify(["U0EXAMPLE001"])}\n`);
    const fixture = fixtureFile(dir, [
      { ...THREAD, ts: "1700000001.000100", user: "U0EXAMPLE001", text: "승인" },
      { ...THREAD, ts: "1700000002.000100", user: "U0EXAMPLE002", text: "승인" },
    ]);

    await runListen(["--fixture", fixture, "--out", out, "--approvers-file", approvers]);

    const candidates = recordedCandidates(out);
    assert.deepEqual(
      candidates.map((candidate) => [candidate.verdict, candidate.reason, candidate.approver]),
      [
        ["approved-candidate", "short-approval-in-request-thread", "U0EXAMPLE001"],
        ["needs-human", "unauthorized-approver", "U0EXAMPLE002"],
      ],
    );
  }));

test("bot and subtype events are never validated; userless approvals surface as needs-human", () =>
  withDir(async (dir) => {
    const out = join(dir, "out.jsonl");
    const approvers = join(dir, "approvers.json");
    writeFileSync(approvers, `${JSON.stringify(["U0EXAMPLE001"])}\n`);
    const fixture = fixtureFile(dir, [
      { ...THREAD, ts: "1700000001.000100", user: "U0EXAMPLE001", text: "approve", bot_id: "B0EXAMPLE001" },
      { ...THREAD, ts: "1700000002.000100", user: "U0EXAMPLE001", text: "approve", subtype: "message_changed" },
      { ...THREAD, ts: "1700000003.000100", text: "approve" },
    ]);

    const summary = await runListen(["--fixture", fixture, "--out", out, "--approvers-file", approvers]);

    const candidates = recordedCandidates(out);
    // Bot/subtype -> not-approval (not recorded); userless -> recorded as needs-human.
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.verdict, "needs-human");
    assert.equal(candidates[0]!.reason, "missing-approver-identity");
    assert.match(summary, /"not-approval":2/);
  }));
