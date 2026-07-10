import type { LedgerEvent } from "../notify/notifier.js";
import type { ClassifiedEnvelope, LedgerAdapter } from "../types.js";

/**
 * GitHub Issues as a ledger: the built-in adapter so gyeoljae is usable
 * outside its original private deployment.
 *
 * Ledger refs use the form "owner/repo#123".
 */

/** Injectable transport so the adapter is testable without a network. */
export interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

export class GitHubRestApi implements GitHubApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${path} failed: ${response.status}`);
    }
    return response.status === 204 ? undefined : response.json();
  }
}

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseLedgerRef(ledgerRef: string): IssueRef {
  const match = ledgerRef.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) throw new Error(`Invalid GitHub ledger ref (expected "owner/repo#123"): ${ledgerRef}`);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

const MARKER_PREFIX = "<!-- gyeoljae:";

function intakeMarker(dedupKey: string): string {
  return `${MARKER_PREFIX}${dedupKey} -->`;
}

/** Content-free intake comment: refs, statuses, and counts only. */
export function renderIntakeComment(envelope: ClassifiedEnvelope): string {
  return [
    intakeMarker(envelope.dedup_key),
    "**Intake recorded** (gyeoljae shadow)",
    "",
    `| | |`,
    `| --- | --- |`,
    `| Source | ${envelope.source} ${envelope.channel_id}/${envelope.thread_ts} |`,
    `| Kind | ${envelope.intake_kind} |`,
    `| Action class | ${envelope.action_class} |`,
    `| Sensitive review | ${envelope.sensitive_review} |`,
    `| File refs | ${envelope.file_refs.length} |`,
    `| Redaction | ${envelope.redaction_status} |`,
    "",
    "_Text excerpt omitted in shadow mode._",
  ].join("\n");
}

export class GitHubIssuesLedger implements LedgerAdapter {
  constructor(private readonly api: GitHubApi) {}

  /** Idempotent on envelope.dedup_key via a hidden HTML marker in the comment body. */
  async recordIntake(envelope: ClassifiedEnvelope): Promise<void> {
    if (!envelope.ledger_ref) throw new Error("Envelope has no ledger_ref; cannot record intake.");
    const ref = parseLedgerRef(envelope.ledger_ref);
    const marker = intakeMarker(envelope.dedup_key);

    const comments = (await this.api.request(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    )) as Array<{ body?: string }>;
    if (comments.some((comment) => comment.body?.includes(marker))) return;

    await this.comment(envelope.ledger_ref, renderIntakeComment(envelope));
  }

  async comment(ledgerRef: string, body: string): Promise<void> {
    const ref = parseLedgerRef(ledgerRef);
    await this.api.request("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body });
  }
}

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  closed_at: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

/**
 * Polls issue state into LedgerEvents for the Notifier.
 *
 * Event keys are stable per state, not per update: an issue labeled
 * approval-needed notifies once until the label cycle repeats; a close
 * notifies once per closed_at. Exactly-once delivery is the Notifier's job.
 */
export class GitHubIssuesWatcher {
  constructor(
    private readonly api: GitHubApi,
    private readonly owner: string,
    private readonly repo: string,
    private readonly approvalLabel = "approval-needed",
  ) {}

  async events(sinceIso: string): Promise<LedgerEvent[]> {
    const issues = (await this.api.request(
      "GET",
      `/repos/${this.owner}/${this.repo}/issues?state=all&since=${encodeURIComponent(sinceIso)}&per_page=100`,
    )) as GitHubIssue[];

    const events: LedgerEvent[] = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const ledgerRef = `${this.owner}/${this.repo}#${issue.number}`;

      if (issue.state === "closed" && issue.closed_at) {
        events.push({
          event_key: `${ledgerRef}:done:${issue.closed_at}`,
          kind: "done",
          ledger_ref: ledgerRef,
          title: issue.title,
          url: issue.html_url,
        });
        continue;
      }
      if (issue.labels.some((label) => label.name === this.approvalLabel)) {
        events.push({
          event_key: `${ledgerRef}:approval-needed`,
          kind: "approval-needed",
          ledger_ref: ledgerRef,
          title: issue.title,
          url: issue.html_url,
        });
      }
    }
    return events;
  }
}
