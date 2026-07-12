import assert from "node:assert/strict";
import { test } from "node:test";

import { Classifier } from "../src/classifier.js";
import { EnvelopeBuilder, publicEnvelope } from "../src/envelope.js";
import {
  GitHubIssuesLedger,
  GitHubIssuesWatcher,
  GitHubWatchSource,
  parseLedgerRef,
  proposalDigest,
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

test("recordIntake finds an existing marker after the first 100 comments", async () => {
  const api = new FakeApi();
  const ledger = new GitHubIssuesLedger(api);
  const first = envelope();
  const path = "/repos/example-org/example-repo/issues/7/comments?per_page=100";

  api.responses.set(`GET ${path}`, Array.from({ length: 100 }, () => ({ body: "unrelated" })));
  api.responses.set(`GET ${path}&page=2`, [{ body: `<!-- gyeoljae:${first.dedup_key} -->` }]);

  await ledger.recordIntake(first);

  assert.ok(api.calls.some((call) => call.path === `${path}&page=2`));
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
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

test("watcher includes issues after the first 100 results", async () => {
  const api = new FakeApi();
  const path = "/repos/example-org/example-repo/issues?state=all&since=2026-01-01T00%3A00%3A00Z&per_page=100";
  api.responses.set(
    `GET ${path}`,
    Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Plain ${index + 1}`,
      state: "open",
      closed_at: null,
      html_url: `https://github.com/example-org/example-repo/issues/${index + 1}`,
      labels: [],
    })),
  );
  api.responses.set(`GET ${path}&page=2`, [{
    number: 101,
    title: "Needs review",
    state: "open",
    closed_at: null,
    html_url: "https://github.com/example-org/example-repo/issues/101",
    labels: [{ name: "approval-needed" }],
  }]);

  const events = await new GitHubIssuesWatcher(api, "example-org", "example-repo").events("2026-01-01T00:00:00Z");

  assert.deepEqual(events.map((event) => event.ledger_ref), ["example-org/example-repo#101"]);
  assert.ok(api.calls.some((call) => call.path === `${path}&page=2`));
});

test("open item scan paginates both issues and comments", async () => {
  const api = new FakeApi();
  const issuesPath = "/repos/example-org/example-repo/issues?state=open&per_page=100";
  api.responses.set(
    `GET ${issuesPath}`,
    Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Pull request ${index + 1}`,
      state: "open",
      closed_at: null,
      html_url: `https://github.com/example-org/example-repo/pull/${index + 1}`,
      labels: [],
      pull_request: {},
    })),
  );
  api.responses.set(`GET ${issuesPath}&page=2`, [{
    number: 101,
    title: "Approval request",
    state: "open",
    closed_at: null,
    html_url: "https://github.com/example-org/example-repo/issues/101",
    labels: [],
  }]);

  const commentsPath = "/repos/example-org/example-repo/issues/101/comments?per_page=100";
  api.responses.set(`GET ${commentsPath}`, Array.from({ length: 100 }, () => ({ body: "context" })));
  api.responses.set(`GET ${commentsPath}&page=2`, [{ body: "## Approval requested" }]);

  const items = await new GitHubWatchSource(api, "example-org", "example-repo").openItems();

  assert.equal(items.length, 1);
  assert.equal(items[0]!.ref, "example-org/example-repo#101");
  assert.equal(items[0]!.comment_bodies.length, 101);
  assert.equal(items[0]!.comment_bodies.at(-1), "## Approval requested");
  assert.ok(api.calls.some((call) => call.path === `${issuesPath}&page=2`));
  assert.ok(api.calls.some((call) => call.path === `${commentsPath}&page=2`));
});

test("open items carry proposal identity from the latest request-marker comment", async () => {
  const api = new FakeApi();
  api.responses.set("GET /repos/example-org/example-repo/issues?state=open&per_page=100", [
    {
      number: 7,
      title: "Proposal",
      state: "open",
      closed_at: null,
      html_url: "https://github.com/example-org/example-repo/issues/7",
      labels: [],
    },
    {
      number: 8,
      title: "No proposal yet",
      state: "open",
      closed_at: null,
      html_url: "https://github.com/example-org/example-repo/issues/8",
      labels: [],
    },
  ]);
  api.responses.set("GET /repos/example-org/example-repo/issues/7/comments?per_page=100", [
    { id: 100, body: "## Approval requested\n\nfirst proposal" },
    { id: 101, body: "discussion — mentions '## Approval requested' but not at start" },
    { id: 102, body: "## Approval requested\n\nsecond proposal" },
  ]);
  api.responses.set("GET /repos/example-org/example-repo/issues/8/comments?per_page=100", [
    { id: 200, body: "just context" },
  ]);

  const [withProposal, withoutProposal] = await new GitHubWatchSource(api, "example-org", "example-repo").openItems();

  // The LATEST marker comment is the current proposal cycle.
  assert.equal(withProposal!.proposal_id, "102");
  assert.equal(withProposal!.proposal_digest, proposalDigest("## Approval requested\n\nsecond proposal"));
  // Digest changes when the proposal body is edited (record-time staleness check).
  assert.notEqual(withProposal!.proposal_digest, proposalDigest("## Approval requested\n\nsecond proposal (edited)"));
  // No marker comment -> no proposal identity -> orchestrator falls back to ref-only keys.
  assert.equal(withoutProposal!.proposal_id, undefined);
  assert.equal(withoutProposal!.proposal_digest, undefined);
});
