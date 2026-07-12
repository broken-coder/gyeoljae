# Recipe: GitHub Issues + Slack quickstart

A minimal end-to-end deployment using only public parts: GitHub Issues as the ledger, Slack as the chat surface, one bridge process on an interval.

> Status note: the inbound poller, GitHub watcher, outbound notifier, and Socket Mode listener ship in `v0.1.1-rc`. Live ledger/chat writes remain opt-in deployment capabilities; start with local-file outputs.

## What you need

- A GitHub repo whose issues act as your ledger, and a token with `issues: read/write` on it
- A Slack app selected from the [outbound-only](../../examples/slack-app-manifest.outbound-only.example.yml) or [full-approval](../../examples/slack-app-manifest.full-approval.example.yml) manifest, depending on whether the bridge must ingest replies
- A host (or container) that can run Node 22+ on a schedule

Keep tokens in [hardened files](../security/token-files.md); gyeoljae reads them in place and never logs them. Keep each local checkpoint under the [single-writer contract](../deployment/local-json-state.md).

## 1. Inbound: channel → sanitized envelopes

Run on an interval (cron shown; launchd/systemd/compose all work — see `examples/docker-compose.example.yml`):

```cron
*/10 * * * * gyeoljae-poll \
  --channel-id C0EXAMPLE001 \
  --token-file /etc/gyeoljae/slack-token \
  --ledger-ref example-org/ops-ledger#1 \
  --state-file /var/lib/gyeoljae/state.json \
  --store /var/lib/gyeoljae/store.json \
  --out /var/lib/gyeoljae/last-run.json
```

What you get per run: sanitized envelopes (no message content, metadata-only file refs) upserted by `dedup_key`, classified `routine` / `agent-required` / `needs-human`, with the last acknowledged timestamp available for replay after an outage.

**Recommended rollout:** run this in shadow (local files only) for a week before wiring any ledger writes. Boring logs are the pass criterion.

## 2. Outbound: ledger → Slack

The packaged `gyeoljae-watch` CLI scans GitHub and writes a shadow outbox. The same shipped watcher/notifier APIs can be composed directly when a deployment is ready to add a reviewed Slack write capability:

```ts
import { GitHubRestApi, GitHubIssuesWatcher } from "gyeoljae/ledger/github";
import { Notifier } from "gyeoljae/notify/notifier";
import { FileChatAdapter } from "gyeoljae/notify/adapters";

const api = new GitHubRestApi(process.env.GITHUB_TOKEN!);
const watcher = new GitHubIssuesWatcher(api, "example-org", "ops-ledger");
// Shadow first: FileChatAdapter writes an outbox file instead of posting.
const notifier = new Notifier(new FileChatAdapter("/var/lib/gyeoljae/outbox.jsonl"), "#approvals", "/var/lib/gyeoljae/notified.json");

const events = await watcher.events(sinceIso);
await notifier.deliver(events);
```

Label an issue `approval-needed` → an approval notification. Close it → a `done` notification. Delivery is **deduplicated at-least-once**: completed event keys are skipped on later runs, while a crash after a remote send but before its checkpoint can repeat a notification.

When the shadow outbox looks right for a few days, swap `FileChatAdapter` for a real Slack `chat.postMessage` adapter — that's the moment your bridge gains its single write credential, so treat it as a reviewed change.

## 3. Agents

Point your agents at [the approval loop recipe](agent-approval-loop.md): they comment proposals onto issues in `example-org/ops-ledger`, add the `approval-needed` label, optionally `POST /nudge`, and resume from recorded approvals.

## 4. Approval replies

The shipped `gyeoljae-listen` CLI receives Socket Mode replies and writes content-free approval candidates locally. Run `gyeoljae-watch --candidates <file>` only after reviewing the GitHub write credential and transition policy; it validates the same thread-scoped rules and records accepted candidates before agents resume. Shadow deployments can keep the operator-recorded path.

## Safety checklist before going live

- [ ] Bridge runs as its own user; token files are `0600` and mounted read-only in containers
- [ ] Startup rejects token-file symlinks, unexpected owners, and group/world permissions
- [ ] Scheduler or supervisor enforces one writer per local JSON path
- [ ] Intake channel and notification channel are **different** channels (loop prevention)
- [ ] Shadow period completed: store shows no duplicates, state advances monotonically, outbox content is ref-only
- [ ] Everyone agrees: chat replies are input, the ledger record is the authority
