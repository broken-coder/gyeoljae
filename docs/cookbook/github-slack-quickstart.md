# Recipe: GitHub Issues + Slack quickstart

A minimal end-to-end deployment using only public parts: GitHub Issues as the ledger, Slack as the chat surface, one bridge process on an interval.

> Status note: the inbound poller, GitHub watcher, outbound notifier, and Socket Mode listener ship in `v0.2.0-rc.1`. The poller and listener can write only local files. The `gyeoljae-watch` CLI keeps chat output local but performs live GitHub ledger transitions when it finds workflow markers.

## What you need

- A GitHub repo whose issues act as your ledger, and a token with `issues: read/write` on it
- A Slack app selected from the [outbound-only](../../examples/slack-app-manifest.outbound-only.example.yml) or [full-approval](../../examples/slack-app-manifest.full-approval.example.yml) manifest, depending on whether the bridge must ingest replies
- A host (or container) that can run Node 22+ on a schedule

Keep tokens in [hardened files](../security/token-files.md); gyeoljae reads them in place and never logs them. Keep each local checkpoint under the [single-writer contract](../deployment/local-json-state.md).

Install the exact release candidate on the scheduled host and record each CLI's absolute path:

```bash
npm install --global gyeoljae@0.2.0-rc.1
command -v gyeoljae-poll
```

## 1. Inbound: channel → sanitized envelopes

Run on an interval (cron shown; launchd/systemd/compose all work — see `examples/docker-compose.example.yml`):

```cron
*/10 * * * * /usr/local/bin/gyeoljae-poll \
  --channel-id C0EXAMPLE001 \
  --token-file /etc/gyeoljae/slack-token \
  --ledger-ref example-org/ops-ledger#1 \
  --state-file /var/lib/gyeoljae/state.json \
  --store /var/lib/gyeoljae/store.json \
  --out /var/lib/gyeoljae/last-run.json
```

Replace `/usr/local/bin/gyeoljae-poll` with the path returned by `command -v`; cron does not reliably inherit an interactive npm `PATH`.

What you get per run: sanitized envelopes (no message content, metadata-only file refs) upserted by `dedup_key`, classified `routine` / `agent-required` / `needs-human`, with the last acknowledged timestamp available for replay after an outage.

**Recommended rollout:** run this in shadow (local files only) for a week before wiring any ledger writes. Boring logs are the pass criterion.

## 2. Outbound: ledger → Slack

For a read-only GitHub preview, compose `GitHubIssuesWatcher` with `FileChatAdapter`. This path reads issue state and writes only a local outbox until the deployment replaces the chat adapter:

```ts
import { readFileSync } from "node:fs";
import { GitHubRestApi, GitHubIssuesWatcher } from "gyeoljae/ledger/github";
import { Notifier } from "gyeoljae/notify/notifier";
import { FileChatAdapter } from "gyeoljae/notify/adapters";

const api = new GitHubRestApi(readFileSync("/etc/gyeoljae/github-token", "utf8").trim());
const watcher = new GitHubIssuesWatcher(api, "example-org", "ops-ledger");
// Shadow first: FileChatAdapter writes an outbox file instead of posting.
const notifier = new Notifier(new FileChatAdapter("/var/lib/gyeoljae/outbox.jsonl"), "#approvals", "/var/lib/gyeoljae/notified.json");

const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const events = await watcher.events(sinceIso);
await notifier.deliver(events);
```

Label an issue `approval-needed` → an approval notification. Close it → a `done` notification. Delivery is **deduplicated at-least-once**: completed event keys are skipped on later runs, while a crash after a remote send but before its checkpoint can repeat a notification.

When the shadow outbox looks right for a few days, swap `FileChatAdapter` for a real Slack `chat.postMessage` adapter — that's the moment your bridge gains its single write credential, so treat it as a reviewed change.

> **`gyeoljae-watch` is not a ledger dry-run.** It always wires `GitHubLedgerControl`: an issue whose comment starts with `## Approval requested` receives a live `blocked` label and comment, while `## 완료` closes the issue and adds a comment. Its `FileChatAdapter` shadows only the chat side. Use a dedicated test repository before enabling this CLI on an operating ledger.

## 3. Agents

Point your agents at [the approval loop recipe](agent-approval-loop.md): they comment proposals onto issues in `example-org/ops-ledger`, add the `approval-needed` label, optionally `POST /nudge`, and resume from recorded approvals.

## 4. Approval replies

The shipped `gyeoljae-listen` CLI receives Socket Mode replies and writes content-free approval candidates locally. Authorization is **fail-closed**: pass `--approvers-file`, a JSON array of chat user ids allowed to approve (keep it `0600`, one writer). Without it the listener still runs but **no reply ever becomes an approved-candidate** — well-formed approvals are recorded as `needs-human` (`authorization-not-configured`). Bot/system messages and subtypes (edits, broadcasts) are never validated; an approval from a non-allowlisted user is recorded as `needs-human` (`unauthorized-approver`), never accepted silently.

```bash
gyeoljae-listen \
  --app-token-file /etc/gyeoljae/slack-app-token \
  --pending-file /var/lib/gyeoljae/pending.json \
  --approvers-file /etc/gyeoljae/approvers.json \
  --inbox-dir /var/lib/gyeoljae/inbox \
  --out /var/lib/gyeoljae/candidates.jsonl
```

`--inbox-dir` (recommended) stores each envelope durably before acking and replays unprocessed ones after a crash; without it, a reply that arrives in the instant between ack and write can be lost.

Run `gyeoljae-watch --candidates <file>` only after reviewing the GitHub write credential and transition policy; the watch pass performs the live marker transitions above and records accepted candidates before agents resume. Shadow deployments can keep the operator-recorded path and the read-only library preview.

## GitHub pagination limits

Each watch pass reads every open issue and every comment page. If GitHub rejects any page, including for rate limiting, the entire pass fails and the next scheduled pass starts from the beginning. Keep the operating ledger focused, monitor API quota, and avoid overlapping passes. Retry/backoff and bounded-page controls are not part of `v0.2.0-rc.1`.

## Safety checklist before going live

- [ ] Bridge runs as its own user; token files are `0600` and mounted read-only in containers
- [ ] Startup rejects token-file symlinks, unexpected owners, and group/world permissions
- [ ] Scheduler or supervisor enforces one writer per local JSON path
- [ ] Approver allowlist (`--approvers-file`) lists exactly the humans who may approve, and only operators can edit it
- [ ] Intake channel and notification channel are **different** channels (loop prevention)
- [ ] Shadow period completed: store shows no duplicates, state advances monotonically, outbox content is ref-only
- [ ] Everyone agrees: chat replies are input, the ledger record is the authority
