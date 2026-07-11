# Recipe: GitHub Issues + Slack quickstart

A minimal end-to-end deployment using only public parts: GitHub Issues as the ledger, Slack as the chat surface, one bridge process on an interval.

> Status note: the inbound poller and outbound notifier core ship today; this recipe marks the pieces that arrive with the Socket Mode milestone.

## What you need

- A GitHub repo whose issues act as your ledger, and a token with `issues: read/write` on it
- A Slack app with a bot token — read scopes for your intake channel, `chat:write` for notifications
- A host (or container) that can run Node 20+ on a schedule

Keep both tokens in files with tight permissions; gyeoljae reads them in place and never logs them.

## 1. Inbound: channel → sanitized envelopes

Run on an interval (cron shown; launchd/systemd/compose all work — see `examples/docker-compose.example.yml`):

```cron
*/10 * * * * node /opt/gyeoljae/dist/src/cli/poll.js \
  --channel-id C0EXAMPLE001 \
  --token-file /etc/gyeoljae/slack-token \
  --ledger-ref example-org/ops-ledger#1 \
  --state-file /var/lib/gyeoljae/state.json \
  --store /var/lib/gyeoljae/store.json \
  --out /var/lib/gyeoljae/last-run.json
```

What you get per run: sanitized envelopes (no message content, metadata-only file refs) upserted into the local store, classified `routine` / `agent-required` / `needs-human`, with the last acknowledged timestamp advancing so re-runs and outages never duplicate or lose events.

**Recommended rollout:** run this in shadow (local files only) for a week before wiring any ledger writes. Boring logs are the pass criterion.

## 2. Outbound: ledger → Slack

Wire the watcher + notifier (a packaged `notify` CLI lands with the Socket Mode milestone; today this is a few lines):

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

Label an issue `approval-needed` → one notification. Close it → one `done` notification. The notifier's state file guarantees exactly-once even if the interval fires twice.

When the shadow outbox looks right for a few days, swap `FileChatAdapter` for a real Slack `chat.postMessage` adapter — that's the moment your bridge gains its single write credential, so treat it as a reviewed change.

## 3. Agents

Point your agents at [the approval loop recipe](agent-approval-loop.md): they comment proposals onto issues in `example-org/ops-ledger`, add the `approval-needed` label, optionally `POST /nudge`, and resume from recorded approvals.

## 4. Approval replies (today vs. next milestone)

Today, a human reads the Slack notification, replies in-thread, and an operator records the approval onto the issue before anything executes. The Socket Mode milestone automates exactly that recording — same thread-scoped validation rules, no change to agent behavior.

## Safety checklist before going live

- [ ] Bridge runs as its own user; token files are `0600` and mounted read-only in containers
- [ ] Intake channel and notification channel are **different** channels (loop prevention)
- [ ] Shadow period completed: store shows no duplicates, state advances monotonically, outbox content is ref-only
- [ ] Everyone agrees: chat replies are input, the ledger record is the authority
