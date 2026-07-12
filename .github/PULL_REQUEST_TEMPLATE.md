## What changed

<!-- One concern per PR. -->

## Why

## Checklist

- [ ] `npm test` passes
- [ ] `npm run check:sanitize` passes (no real workspace IDs, tokens, or hostnames anywhere)
- [ ] `npm run smoke:package` passes (packed imports and CLI resolve from a blank project)
- [ ] Core behavior changes include a test documenting the new behavior and a rationale above
- [ ] No new runtime dependencies (or the PR body argues for the exception)
