# Getting started

> gyeoljae is early-stage. `v0.1.1-rc.1` ships the core library, `poll`/`listen`/`watch` CLIs, notifier, Slack Socket Mode listener, and GitHub Issues adapter. The watch CLI uses a local chat outbox but performs live GitHub label/comment/close transitions when it sees workflow markers.

## The mental model in 60 seconds

You have **agents** doing work, a **ledger** that owns the truth about that work (GitHub Issues, Linear, or your own tracker), and a **messenger** where humans actually live (Slack). gyeoljae is the deterministic middle piece:

1. **Inbound**: a message or file lands in a channel → gyeoljae wraps it in a *sanitized envelope* (metadata only, never content) → records it in the ledger **before anything else happens** → classifies it: `routine`, `agent-required`, or `needs-human`.
2. **Outbound**: the ledger says "this issue needs a human decision" → gyeoljae posts a notification to the messenger (refs and statuses only).
3. **Approval loop**: a human replies "approve" in the thread → gyeoljae validates the reply belongs to the proposal thread, doesn't widen its scope, and comes from an **authorized approver** (fail-closed: no configured allowlist ⇒ no auto-approval; bot/system and missing-user replies are rejected) → records the approval in the ledger → the waiting agent resumes.

The bridge never interprets content. Credentials are isolated from agents and read only by the bridge process from [hardened token files](security/token-files.md). Every ambiguity becomes `needs-human`.

## Using the core library today

```ts
import { EnvelopeBuilder, publicEnvelope } from "gyeoljae/envelope";
import { Classifier } from "gyeoljae/classifier";

const document = {
  ledger_ref: "EX-28",            // the issue this thread maps to (or null)
  channel_id: "C0EXAMPLE001",
  thread_ts: "1700000000.000100",
  messages: [
    { ts: "1700000000.000100", text: "invoice for review", files: [
      { id: "FEXAMPLE", name: "invoice.pdf", mimetype: "application/pdf", size: 1024 },
    ]},
  ],
};

const envelopes = new EnvelopeBuilder(document).build();
const classified = new Classifier(envelopes).classify();
const safeToStore = classified.map(publicEnvelope);

// classified[0].classification_status === "agent-required"  (PDF present)
// classified[0].sensitive_review === true
// classified[0].text_excerpt === null                        (always, in shadow mode)
```

## Key invariants you can rely on

| Invariant | Meaning |
| --- | --- |
| Record first | An envelope reaches the ledger before any routing decision acts on it. A classifier bug means "recorded but unprocessed", never a lost event. |
| `text_excerpt: null` | In shadow mode, message content never leaves the chat platform. File refs are id/name/mime/size/hash only. |
| Idempotent `dedup_key` | `slack:<channel>:<thread_ts>:<ts>`. Retries, replays, and edits never create duplicate records; edits bump `version` and record `edited_ts`. |
| Replay recovery | If the ledger is down, recovery is re-reading chat history after the last acknowledged timestamp — no durable queue to operate. |
| Deterministic routing | Approval detection and classification are regex/metadata rules you can read in one screen. No model calls. |

## Deployment shape

The shipped rollout shape is a one-shot poller on an interval (cron or launchd), a Socket Mode listener for approval replies, and a GitHub watcher with a local "nudge" endpoint. The Socket Mode listener is at-least-once: run it with `--inbox-dir` for a store-then-ack durable inbox (acked envelopes survive a crash and replay on restart), or pair it with a history-reconciliation poller. Without one of the two, an ack-then-crash can drop a reply. The poller and listener support local-file rollout. For read-only GitHub preview, compose `GitHubIssuesWatcher` with `FileChatAdapter`; do not use `gyeoljae-watch` as a dry-run because it wires live ledger control. Every local JSON path has a [single-writer requirement](deployment/local-json-state.md).

## FAQ

**Why not just a Slack workflow?** Slack keeps the conversation; your ledger keeps the authority. Approvals that only exist in chat disappear with the thread. gyeoljae's whole job is making the ledger record land first.

**Can the bridge summarize/extract the files people upload?** No, by design. That's agent work behind a `LedgerAdapter`. The bridge flags `agent-required` and gets out of the way.

**Why "gyeoljae"?** 결재 is the Korean office ritual of getting a decision-maker's stamp before work proceeds. That's literally what this does.
