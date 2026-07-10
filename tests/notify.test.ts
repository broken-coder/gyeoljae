import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileChatAdapter } from "../src/notify/adapters.js";
import { Notifier, renderNotification, type LedgerEvent } from "../src/notify/notifier.js";
import { NudgeServer } from "../src/notify/nudge.js";
import type { ChatAdapter } from "../src/types.js";

const EVENT: LedgerEvent = {
  event_key: "EX-12:approval-needed:2026-07-10T12:00:00Z",
  kind: "approval-needed",
  ledger_ref: "EX-12",
  title: "Rotate the example credential",
  url: "https://ledger.example.com/EX-12",
};

class RecordingChat implements ChatAdapter {
  sent: string[] = [];
  failNext = false;

  async notify(_channel: string, body: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("send failed");
    }
    this.sent.push(body);
  }
}

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-"));
  const result = run(dir);
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("notification rendering is content-free", () => {
  const rendered = renderNotification(EVENT);
  assert.equal(rendered, "🔏 Approval needed: EX-12 Rotate the example credential — https://ledger.example.com/EX-12");
});

test("notifier delivers each event exactly once across runs", () =>
  withDir(async (dir) => {
    const chat = new RecordingChat();
    const notifier = new Notifier(chat, "#example", join(dir, "notified.json"));

    const first = await notifier.deliver([EVENT]);
    const second = await notifier.deliver([EVENT]);

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(chat.sent.length, 1);
  }));

test("failed send is retried on the next run", () =>
  withDir(async (dir) => {
    const chat = new RecordingChat();
    const notifier = new Notifier(chat, "#example", join(dir, "notified.json"));

    chat.failNext = true;
    await assert.rejects(notifier.deliver([EVENT]));
    const retried = await notifier.deliver([EVENT]);

    assert.equal(retried.length, 1);
    assert.equal(chat.sent.length, 1);
  }));

test("file chat adapter appends jsonl without posting anywhere", () =>
  withDir(async (dir) => {
    const path = join(dir, "outbox.jsonl");
    const adapter = new FileChatAdapter(path);
    await adapter.notify("#example", "hello");
    await adapter.notify("#example", "world");

    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { body: string });
    assert.deepEqual(lines.map((line) => line.body), ["hello", "world"]);
  }));

test("nudge server debounces bursts into one check", async () => {
  let checks = 0;
  const server = new NudgeServer(() => {
    checks += 1;
  }, 50);
  const port = await server.listen(0);

  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`http://127.0.0.1:${port}/nudge`, { method: "POST" })),
    );
    assert.ok(responses.every((response) => response.status === 202));

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(checks, 1);

    const missed = await fetch(`http://127.0.0.1:${port}/other`, { method: "GET" });
    assert.equal(missed.status, 404);
  } finally {
    server.close();
  }
});
