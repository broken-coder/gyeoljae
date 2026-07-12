import assert from "node:assert/strict";
import { test } from "node:test";

import { SlackClient, type FetchLike } from "../src/slack/client.js";

interface PageSpec {
  messages: Array<{ ts: string }>;
  next_cursor?: string;
}

function fakeFetch(pages: PageSpec[], calls: string[]): FetchLike {
  let index = 0;
  return async (url) => {
    calls.push(url);
    const page = pages[Math.min(index, pages.length - 1)]!;
    index += 1;
    return {
      json: async () => ({
        ok: true,
        messages: page.messages,
        ...(page.next_cursor ? { response_metadata: { next_cursor: page.next_cursor } } : {}),
      }),
    };
  };
}

test("history with oldest follows cursors until the window is exhausted", async () => {
  const calls: string[] = [];
  const client = new SlackClient("xoxb-test", {
    fetchImpl: fakeFetch(
      [
        { messages: [{ ts: "1700000300.000000" }, { ts: "1700000200.000000" }], next_cursor: "c2" },
        { messages: [{ ts: "1700000100.000000" }], next_cursor: "c3" },
        { messages: [{ ts: "1700000050.000000" }] },
      ],
      calls,
    ),
  });

  const messages = await client.history("C0EXAMPLE001", 2, "1700000000.000100");

  assert.equal(messages.length, 4);
  assert.equal(calls.length, 3);
  assert.match(calls[0]!, /oldest=1700000000\.000100/);
  assert.ok(!calls[0]!.includes("cursor="));
  assert.match(calls[1]!, /cursor=c2/);
  assert.match(calls[2]!, /cursor=c3/);
});

test("history without oldest stays a single newest page", async () => {
  const calls: string[] = [];
  const client = new SlackClient("xoxb-test", {
    fetchImpl: fakeFetch([{ messages: [{ ts: "1.0" }], next_cursor: "would-continue" }], calls),
  });

  const messages = await client.history("C0EXAMPLE001", 50);

  assert.equal(messages.length, 1);
  assert.equal(calls.length, 1, "no cursor follow-up without an ack window");
});

test("replies paginate past the first page", async () => {
  const calls: string[] = [];
  const client = new SlackClient("xoxb-test", {
    fetchImpl: fakeFetch(
      [
        { messages: [{ ts: "1.0" }, { ts: "2.0" }], next_cursor: "c2" },
        { messages: [{ ts: "3.0" }] },
      ],
      calls,
    ),
  });

  const messages = await client.replies("C0EXAMPLE001", "1.0", 2);

  assert.deepEqual(messages.map((message) => message.ts), ["1.0", "2.0", "3.0"]);
  assert.match(calls[1]!, /cursor=c2/);
});

test("a never-ending cursor aborts at the page cap instead of truncating silently", async () => {
  const client = new SlackClient("xoxb-test", {
    fetchImpl: fakeFetch([{ messages: [{ ts: "1.0" }], next_cursor: "again" }], []),
  });

  await assert.rejects(
    client.history("C0EXAMPLE001", 1, "1700000000.000100"),
    /exceeded 100 pages/,
  );
});

test("an error payload surfaces the Slack error code", async () => {
  const client = new SlackClient("xoxb-test", {
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: "ratelimited", messages: [] }) }),
  });

  await assert.rejects(client.history("C0EXAMPLE001", 1), /ratelimited/);
});
