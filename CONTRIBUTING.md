# Contributing to gyeoljae

Thanks for your interest! gyeoljae is early-stage; the fastest way to help is to open an issue describing your use case before writing code.

## Development setup

```bash
git clone https://github.com/YOUR-ACCOUNT/gyeoljae.git
cd gyeoljae
git remote add upstream https://github.com/broken-coder/gyeoljae.git
git fetch upstream
git switch -c fix/short-description upstream/main
npm install
npm test
npm run check:sanitize
npm run smoke:package
```

Fork the repository on GitHub before running these commands. Requires Node 22+ because the Slack Socket Mode client uses the global `WebSocket`. No runtime dependencies; keep it that way unless a PR discussion concludes otherwise.

## Ground rules

1. **The golden spec wins.** The core (envelope builder, classifier, store, replay) is a port of a battle-tested private Ruby implementation. Behavioral changes to the core need a test that documents the new behavior *and* a rationale in the PR body. Wire format (snake_case envelope keys, dedup key shape) is frozen.
2. **The bridge never judges content.** PRs that add LLM calls, content parsing, or agent-visible credential handling to the bridge core will be declined. Credentials stay isolated from agents and are read only by bridge adapters and CLI entrypoints from operator-managed files. Ambiguity must degrade to `needs-human`, never to silent progress.
3. **Sanitization is non-negotiable.** No real workspace IDs, tokens, hostnames, or issue references in code, tests, fixtures, or docs — use `C0EXAMPLE...`, `EX-1`, `example.slack.com`. CI runs a sanitization check (`npm run check:sanitize`); it must pass.
4. **Small PRs.** One concern per PR. Refactors separate from behavior changes.

## Workflow

- Fork → branch (`feat/...`, `fix/...`, `docs/...`) → PR against `main`.
- Every PR needs passing CI (`npm test` + sanitization check + package smoke).
- Commit messages: imperative mood, `type: summary` (e.g. `feat: add telegram chat adapter`).

## Adding an adapter

Implement `LedgerAdapter` or `ChatAdapter` from `src/types.ts`. Requirements:

- `recordIntake` must be idempotent on `envelope.dedup_key`.
- Notifications must carry refs and statuses only — never message content.
- Include a test using generic fixtures.

## Release candidates

Prerelease versions must not replace npm's `latest` tag. After a separate publish approval, release an RC with `npm publish --tag next`; preparing or reviewing a PR never authorizes that command.

## Reporting issues

Use the issue templates. For anything security-sensitive, see [SECURITY.md](SECURITY.md) — do not open a public issue.
