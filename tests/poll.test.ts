import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPoll } from "../src/cli/poll.js";

test("a null state checkpoint is treated as no checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gyeoljae-poll-"));
  const tokenPath = join(dir, "token");
  const statePath = join(dir, "state.json");
  const outPath = join(dir, "out.json");
  writeFileSync(tokenPath, "xoxb-test\n");
  chmodSync(tokenPath, 0o600);
  writeFileSync(statePath, `${JSON.stringify({ last_ack_ts: null })}\n`);

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return { json: async () => ({ ok: true, messages: [] }) } as Response;
  }) as typeof fetch;

  try {
    await runPoll([
      "--channel-id",
      "C0EXAMPLE001",
      "--token-file",
      tokenPath,
      "--state-file",
      statePath,
      "--out",
      outPath,
    ]);

    assert.equal(calls.length, 1);
    assert.ok(!calls[0]!.includes("oldest="), calls[0]);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).last_ack_ts, null);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
