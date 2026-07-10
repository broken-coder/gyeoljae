# Contributing to gyeoljae

Thanks for your interest! gyeoljae is early-stage; the fastest way to help is to open an issue describing your use case before writing code.

## Development setup

```bash
git clone https://github.com/broken-coder/gyeoljae.git
cd gyeoljae
npm install
npm test
```

Requires Node 20+. No runtime dependencies; keep it that way unless a PR discussion concludes otherwise.

## Ground rules

1. **The golden spec wins.** The core (envelope builder, classifier, store, replay) is a port of a battle-tested private Ruby implementation. Behavioral changes to the core need a test that documents the new behavior *and* a rationale in the PR body. Wire format (snake_case envelope keys, dedup key shape) is frozen.
2. **The bridge never judges content.** PRs that add LLM calls, content parsing, or credential handling to the bridge core will be declined — that work belongs in agents behind a `LedgerAdapter`, not here. Ambiguity must degrade to `needs-human`, never to silent progress.
3. **Sanitization is non-negotiable.** No real workspace IDs, tokens, hostnames, or issue references in code, tests, fixtures, or docs — use `C0EXAMPLE...`, `EX-1`, `example.slack.com`. CI runs a sanitization check (`npm run check:sanitize`); it must pass.
4. **Small PRs.** One concern per PR. Refactors separate from behavior changes.

## Workflow

- Fork → branch (`feat/...`, `fix/...`, `docs/...`) → PR against `main`.
- Every PR needs passing CI (`npm test` + sanitization check).
- Commit messages: imperative mood, `type: summary` (e.g. `feat: add telegram chat adapter`).

## Adding an adapter

Implement `LedgerAdapter` or `ChatAdapter` from `src/types.ts`. Requirements:

- `recordIntake` must be idempotent on `envelope.dedup_key`.
- Notifications must carry refs and statuses only — never message content.
- Include a test using generic fixtures.

## Reporting issues

Use the issue templates. For anything security-sensitive, see [SECURITY.md](SECURITY.md) — do not open a public issue.
