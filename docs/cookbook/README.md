# gyeoljae cookbook

Recipes for wiring gyeoljae into agent-driven operations. Start with the [getting-started guide](../getting-started.md) for the mental model; come here for the "how do I actually hook my agents up" part.

| Recipe | For |
| --- | --- |
| [The agent approval loop](agent-approval-loop.md) | Anyone building an AI agent (Claude Code, Codex CLI, custom LLM loops) that needs human sign-off before risky actions |
| [GitHub Issues + Slack quickstart](github-slack-quickstart.md) | A minimal end-to-end deployment with public parts only |

## The one rule that makes everything else work

**Agents talk to the ledger. Only the bridge talks to chat.**

Your agents never hold chat credentials and never post notifications. They write to the ledger (an issue comment, a label, a status change) and optionally nudge the bridge. The bridge — deterministic, auditable, one credential — carries state to humans and human decisions back. If you find yourself giving an agent a chat token, you are rebuilding the problem this project exists to remove.
