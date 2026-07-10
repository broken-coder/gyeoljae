# Recipe: the agent approval loop

How any AI agent — Claude Code, Codex CLI, OpenClaw-style always-on agents, or a custom LLM loop — gets human sign-off through gyeoljae without ever touching chat credentials.

## The loop

```
agent                 ledger                bridge                human (chat)
  │  1. write proposal  │                     │                     │
  ├────────────────────▶│                     │                     │
  │  2. nudge (optional)│────── watch ───────▶│  3. notify          │
  ├─────────────────────┼────────────────────▶├────────────────────▶│
  │                     │                     │  4. "approve" reply │
  │                     │  5. record approval │◀────────────────────┤
  │  6. resume          │◀────────────────────┤                     │
  │◀────────────────────┤                     │                     │
```

## Step 1 — the agent writes a scoped proposal to the ledger

Before any risky action, the agent posts a comment on its ledger issue with **five required fields**. This is the contract that makes a later one-word approval meaningful:

```markdown
## Approval requested

- **Target**: the production database `example-db`
- **Action**: run migration 0042 (adds index, no data change)
- **Scope**: this migration only; no schema changes beyond the index
- **Rollback**: `DROP INDEX example_idx` — 1 command, no data loss
- **Evidence**: results will be posted to this issue
```

Then it marks the issue as awaiting a human (with the GitHub adapter: add the `approval-needed` label).

**Why five fields?** A bare "can I proceed?" forces the human to reconstruct context. A scoped proposal means the human's "approve" has exact, auditable meaning — and anything outside the stated scope still requires a new proposal.

## Step 2 — nudge (optional, for latency)

If the bridge runs on the same host, the agent pings it so the notification goes out in seconds instead of at the next poll:

```bash
curl -s -X POST http://127.0.0.1:8787/nudge
```

The nudge carries no trusted payload — it only means "read the ledger now." A lost nudge costs nothing: the poll interval is the safety net.

## Step 3-4 — the bridge notifies; the human replies in-thread

The bridge posts a content-free notification (`🔏 Approval needed: example-org/repo#7 …`) linking to the issue. The human replies in that thread. Replies that widen the scope are **not** approvals — they're new proposals.

## Step 5-6 — recording, then resuming

The approval is recorded back onto the ledger issue *before* anything executes (in shadow deployments, an operator does this; the Socket Mode milestone automates it). The agent resumes only from ledger state:

```
on wake:
  issue = ledger.get(my_issue)
  if issue has approval recorded for my proposal:
      execute exactly the approved scope
      post evidence to the issue
  else:
      keep waiting (or exit; the next wake re-checks)
```

## Rules your agent must follow

1. **Never block-wait on chat.** Write the proposal, mark the issue, exit or move on. Resume from ledger state.
2. **Never treat a chat message as authority.** If it isn't recorded on the ledger issue, it didn't happen.
3. **Never exceed the approved scope.** New need → new proposal. This is what keeps one-word approvals safe.
4. **Post evidence where you promised.** The proposal's Evidence field is a commitment.

## Wiring examples

**Claude Code / Codex CLI (session agents):** the agent uses `gh issue comment` (or your tracker's CLI) for steps 1 and 6, plus the `curl` nudge. No gyeoljae SDK needed — the ledger is the API.

**Always-on agents:** same contract; the resume signal is your scheduler re-running the agent against the issue, not a chat callback.

**Custom code:** use the library directly — `GitHubIssuesLedger.comment()` for proposals, `NudgeServer` on the bridge side.
