# gyeoljae (결재)

**Human-in-the-loop approval bridge between your ops ledger and your messenger.**

*Gyeoljae* is the Korean ritual of getting the boss's stamp before work proceeds. This service does exactly that for agent-driven operations: agents file their work in a ledger, humans approve from chat, and nothing high-risk moves without a recorded sign-off.

> Status: early. Extracted from a private operating system where a Ruby shadow implementation has been running in production since day one. The Ruby test suite serves as the golden spec for this TypeScript port.

> Release candidate: `v0.2.0-rc.2` packages the library and `poll`/`listen`/`watch` CLIs. Public envelopes strip both source text and `redacted_text` after [PR #13](https://github.com/broken-coder/gyeoljae/pull/13).

## Why

If you run autonomous agents against real infrastructure, you learn two things quickly:

1. **Every intake must land in the ledger before anything acts on it.** An agent that crashes after reading a message loses the message; a bridge that records first degrades to "recorded but unprocessed."
2. **Approvals belong in chat, but authority belongs in the ledger.** Humans live in Slack; the source of truth cannot.

gyeoljae is the thin, deterministic piece between the two. It is deliberately **not** an agent: it never interprets content, credentials are isolated from agents and read only by the bridge process, and anything ambiguous degrades to `needs-human` — never to silent progress.

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
- Notification delivery is **deduplicated at-least-once** by default (a crash after a remote send but before the checkpoint can repeat). Back the notifier with an `Outbox` for explicit pending → sending → sent state (events enqueued durably before the ledger transition), stored receipts, reconciliation of the post crash window, and a drain that retries sends whose items have already left the open set.
- Outage recovery is **replay from chat history** after the last acknowledged timestamp — no durable queue to babysit.
- Message edits keep their identity: same `dedup_key`, recorded `edited_ts`, incremented `version`.
- Notifications carry ledger refs and statuses, never content.

## Adapters

| Kind | Built-in | Bring your own |
| --- | --- | --- |
| Chat | Slack polling + Socket Mode listener (shipped; live writes deployment-gated) | `ChatAdapter` interface; multi-channel fan-out via [Apprise](https://github.com/caronc/apprise) planned |
| Ledger | GitHub Issues (shipped) | `LedgerAdapter` interface |

The original deployment uses a private ledger ([Paperclip](https://paperclip.ai)) through the same adapter interface.

## Development

```bash
npm install
npm test
npm run check:sanitize
npm run smoke:package
```

The package is ESM-only. Use `import`; CommonJS `require()` is not part of the `v0.2.0-rc.2` package contract.

## Docs

- [Getting started](docs/getting-started.md) — mental model, library usage, invariants
- [Cookbook](docs/cookbook/README.md) — wiring AI agents into the approval loop, end-to-end deployment recipes
- [Token-file hardening](docs/security/token-files.md) — ownership, permissions, symlink checks, and rotation
- [Local JSON state](docs/deployment/local-json-state.md) — required single-writer deployment contract
- [Release notes](docs/releases/v0.2.0-rc.2.md) — Developer Preview limitations and upgrade notes

## Roadmap

- [x] Core: envelope builder, classifier (ported, golden-spec tested)
- [x] Shadow store + replay planner port
- [x] Slack inbound poller (one-shot, cron/launchd friendly)
- [x] Redaction pipeline port (redaction_status/manifest envelope fields)
- [x] Outbound notifier (ledger → chat) with nudge endpoint for low-latency approval requests
- [x] Slack Socket Mode listener for real-time approval replies (live shadow rollout gated per deployment)
- [x] GitHub Issues ledger adapter
- [x] Docker packaging

## License

MIT
