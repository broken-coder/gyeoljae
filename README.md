# gyeoljae (결재)

**Human-in-the-loop approval bridge between your ops ledger and your messenger.**

*Gyeoljae* is the Korean ritual of getting the boss's stamp before work proceeds. This service does exactly that for agent-driven operations: agents file their work in a ledger, humans approve from chat, and nothing high-risk moves without a recorded sign-off.

> Status: early. Extracted from a private operating system where a Ruby shadow implementation has been running in production since day one. The Ruby test suite serves as the golden spec for this TypeScript port.

## Why

If you run autonomous agents against real infrastructure, you learn two things quickly:

1. **Every intake must land in the ledger before anything acts on it.** An agent that crashes after reading a message loses the message; a bridge that records first degrades to "recorded but unprocessed."
2. **Approvals belong in chat, but authority belongs in the ledger.** Humans live in Slack; the source of truth cannot.

gyeoljae is the thin, deterministic piece between the two. It is deliberately **not** an agent: it never interprets content, never touches credentials, and anything ambiguous degrades to `needs-human` — never to silent progress.

## Architecture

```
chat (Slack, ...) ──inbound──▶ sanitized envelope ──▶ ledger (record first)
                                                          │
                                        router: routine │ agent-required │ needs-human
                                                          │
ledger events (approval needed, done) ──outbound──▶ chat notification
human reply ("approve") ──inbound──▶ validated ──▶ ledger record ──▶ agent resumes
```

Core rules, enforced in code:

- `text_excerpt` is **always null** in shadow mode; file refs are metadata-only (id, name, mime, size, hash). Contents are never read.
- Every envelope has an idempotent `dedup_key`; replays and retries create no duplicates.
- Outage recovery is **replay from chat history** after the last acknowledged timestamp — no durable queue to babysit.
- Message edits keep their identity: same `dedup_key`, recorded `edited_ts`, incremented `version`.
- Notifications carry ledger refs and statuses, never content.

## Adapters

| Kind | Built-in | Bring your own |
| --- | --- | --- |
| Chat | Slack (Socket Mode planned) | `ChatAdapter` interface; multi-channel fan-out via [Apprise](https://github.com/caronc/apprise) planned |
| Ledger | GitHub Issues (planned) | `LedgerAdapter` interface |

The original deployment uses a private ledger ([Paperclip](https://paperclip.ai)) through the same adapter interface.

## Development

```bash
npm install
npm test
```

## Roadmap

- [x] Core: envelope builder, classifier (ported, golden-spec tested)
- [x] Shadow store + replay planner port
- [x] Slack inbound poller (one-shot, cron/launchd friendly)
- [x] Redaction pipeline port (redaction_status/manifest envelope fields)
- [x] Outbound notifier (ledger → chat) with nudge endpoint for low-latency approval requests
- [ ] Slack Socket Mode listener for real-time approval replies
- [ ] GitHub Issues ledger adapter
- [ ] Docker packaging

## License

MIT
