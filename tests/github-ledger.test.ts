import assert from "node:assert/strict";
import { test } from "node:test";

import { Classifier } from "../src/classifier.js";
import { EnvelopeBuilder, publicEnvelope } from "../src/envelope.js";
import {
  GitHubIssuesLedger,
  GitHubIssuesWatcher,
  parseLedgerRef,
  renderIntakeComment,
  type GitHubApi,
} from "../src/ledger/github.js";
import type { ClassifiedEnvelope, ThreadDocument } from "../src/types.js";

class FakeApi implements GitHubApi {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  responses = new Map<string, unknown>();

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    return this.responses.get(`${method} ${path}`) ?? [];
  }
}

function envelope(): ClassifiedEnvelope {
  const document: ThreadDocument = {
    ledger_ref: "example-org/example-repo#7",
    channel_id: "C0EXAMPLE001",
    thread_ts: "1700000000.000100",
    messages: [{ ts: "1700000000.000100", text: "invoice attached", files: [{ id: "F1", mimetype: "application/pdf" }] }],
  };
  const classified = new Classifier(new EnvelopeBuilder(document).build()).classify();
  return publicEnvelope(classified[0]!) as ClassifiedEnvelope;
}

test("parseLedgerRef parses and rejects", () => {
  assert.deepEqual(parseLedgerRef("example-org/example-repo#7"), {
    owner: "example-org",
    repo: "example-repo",
    number: 7,
  });
  assert.throws(() => parseLedgerRef("not-a-ref"), /Invalid GitHub ledger ref/);
});

test("recordIntake posts a marked, content-free comment once", async () => {
  const api = new FakeApi();
  const ledger = new GitHubIssuesLedger(api);
  const first = envelope();

  await ledger.recordIntake(first);
  const post = api.calls.find((call) => call.method === "POST");
  assert.ok(post, "posts a comment on first record");
  const body = (post!.body as { body: string }).body;
  assert.ok(body.includes(`<!-- gyeoljae:${first.dedup_key} -->`));
  assert.ok(!body.includes("invoice attached"), "message content must not reach the ledger comment");

  // Second call: the comment now exists → no new POST.
  api.responses.set(
    "GET /repos/example-org/example-repo/issues/7/comments?per_page=100",
    [{ body }],
  );
  const postsBefore = api.calls.filter((call) => call.method === "POST").length;
  await ledger.recordIntake(first);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, postsBefore);
});

test("renderIntakeComment carries classification but no text", () => {
  const rendered = renderIntakeComment(envelope());
  assert.match(rendered, /Action class \| agent-required/);
  assert.match(rendered, /Sensitive review \| true/);
  assert.ok(!rendered.includes("invoice attached"));
});

test("watcher maps closed issues and approval labels to events, skips PRs", async () => {
  const api = new FakeApi();
  api.responses.set(
    "GET /repos/example-org/example-repo/issues?state=all&since=2026-01-01T00%3A00%3A00Z&per_page=100",
    [
      { number: 1, title: "Done thing", state: "closed", closed_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/example-org/example-repo/issues/1", labels: [] },
      { number: 2, title: "Needs stamp", state: "open", closed_at: null, html_url: "https://github.com/example-org/example-repo/issues/2", labels: [{ name: "approval-needed" }] },
      { number: 3, title: "A PR", state: "open", closed_at: null, html_url: "https://github.com/example-org/example-repo/pull/3", labels: [{ name: "approval-needed" }], pull_request: {} },
      { number: 4, title: "Plain open issue", state: "open", closed_at: null, html_url: "https://github.com/example-org/example-repo/issues/4", labels: [] },
    ],
  );
  const watcher = new GitHubIssuesWatcher(api, "example-org", "example-repo");
  const events = await watcher.events("2026-01-01T00:00:00Z");

  assert.deepEqual(
    events.map((event) => [event.kind, event.ledger_ref]),
    [
      ["done", "example-org/example-repo#1"],
      ["approval-needed", "example-org/example-repo#2"],
    ],
  );
  assert.equal(events[0]!.event_key, "example-org/example-repo#1:done:2026-01-02T00:00:00Z");
});
