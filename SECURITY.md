# Security Policy

gyeoljae sits between your messenger and your operating ledger, so we take reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use [GitHub private vulnerability reporting](https://github.com/broken-coder/gyeoljae/security/advisories/new) instead. You should receive a first response within a week.

## Scope of interest

- Anything that lets message content bypass envelope sanitization (`text_excerpt` must stay null in shadow mode; file refs must stay metadata-only)
- Approval validation bypass (a reply outside the proposal thread, or a scope-widening reply, being treated as a valid approval)
- Dedup/idempotency breaks that could double-execute an approved action
- Token handling issues (tokens must only ever be read in place from a caller-supplied file, never logged or persisted)

## Out of scope

- Vulnerabilities in Slack, your ledger, or other third-party services
- Issues requiring a compromised host (the bridge trusts its own filesystem)
