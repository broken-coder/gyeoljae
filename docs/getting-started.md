# Getting started

> gyeoljae is early-stage. Today it ships the core library (envelope builder + classifier). The pollers, notifier, and adapters on the [roadmap](../README.md#roadmap) turn it into a runnable service.

## The mental model in 60 seconds

You have **agents** doing work, a **ledger** that owns the truth about that work (GitHub Issues, Linear, or your own tracker), and a **messenger** where humans actually live (Slack). gyeoljae is the deterministic middle piece:

1. **Inbound**: a message or file lands in a channel → gyeoljae wraps it in a *sanitized envelope* (metadata only, never content) → records it in the ledger **before anything else happens** → classifies it: `routine`, `agent-required`, or `needs-human`.
2. **Outbound**: the ledger says "this issue needs a human decision" → gyeoljae posts a notification to the messenger (refs and statuses only).
3. **Approval loop**: a human replies "approve" in the thread → gyeoljae validates the reply belongs to the proposal thread and doesn't widen its scope → records the approval in the ledger → the waiting agent resumes.

The bridge never interprets content, never touches credentials, and treats every ambiguity as `needs-human`.

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

## Deployment shape (roadmap)

The intended production shape is a one-shot poller on an interval (cron or launchd — a template ships with the repo) during rollout, then an event-driven listener plus an outbound notifier with a local "nudge" endpoint so approval requests reach humans in seconds while polling remains the safety net.

## FAQ

**Why not just a Slack workflow?** Slack keeps the conversation; your ledger keeps the authority. Approvals that only exist in chat disappear with the thread. gyeoljae's whole job is making the ledger record land first.

**Can the bridge summarize/extract the files people upload?** No, by design. That's agent work behind a `LedgerAdapter`. The bridge flags `agent-required` and gets out of the way.

**Why "gyeoljae"?** 결재 is the Korean office ritual of getting a decision-maker's stamp before work proceeds. That's literally what this does.
