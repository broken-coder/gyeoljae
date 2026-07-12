import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Notifier, type LedgerEvent } from "../src/notify/notifier.js";
import { SlackChatAdapter, type PostReceipt } from "../src/notify/slack.js";

const EVENT: LedgerEvent = {
  event_key: "EX-64:approval-needed",
  kind: "approval-needed",
  ledger_ref: "EX-64",
  title: "Round trip test",
};

test("slack adapter posts and returns the receipt through the notifier", async () => {
  const posts: Array<{ channel: string; text: string }> = [];
  const adapter = new SlackChatAdapter("xoxb-test", async (_token, channel, text): Promise<PostReceipt> => {
    posts.push({ channel, text });
    return { channel, ts: "1700000500.000001" };
  });

  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-"));
  try {
    const notifier = new Notifier(adapter, "C0EXAMPLE009", join(dir, "notified.json"));
    const delivered = await notifier.deliver([EVENT]);

    assert.equal(delivered.length, 1);
    const receipt = delivered[0]!.receipt as PostReceipt;
    assert.equal(receipt.ts, "1700000500.000001");
    assert.equal(posts[0]!.channel, "C0EXAMPLE009");
    assert.match(posts[0]!.text, /Approval needed: EX-64/);

    const rerun = await notifier.deliver([EVENT]);
    assert.equal(rerun.length, 0, "receipts preserve completed-run deduplication");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
