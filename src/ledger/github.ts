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

const PAGE_SIZE = 100;

async function getAllPages<T>(api: GitHubApi, path: string): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page += 1) {
    const pagePath = page === 1 ? path : `${path}${path.includes("?") ? "&" : "?"}page=${page}`;
    const response = await api.request("GET", pagePath);
    if (!Array.isArray(response)) throw new Error(`GitHub API GET ${pagePath} did not return an array.`);
    results.push(...(response as T[]));
    if (response.length < PAGE_SIZE) return results;
  }
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

    const comments = await getAllPages<{ body?: string }>(
      this.api,
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    );
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
 * notifies once per closed_at. Delivery is deduplicated at-least-once by the Notifier.
 */
export class GitHubIssuesWatcher {
  constructor(
    private readonly api: GitHubApi,
    private readonly owner: string,
    private readonly repo: string,
    private readonly approvalLabel = "approval-needed",
  ) {}

  async events(sinceIso: string): Promise<LedgerEvent[]> {
    const issues = await getAllPages<GitHubIssue>(
      this.api,
      `/repos/${this.owner}/${this.repo}/issues?state=all&since=${encodeURIComponent(sinceIso)}&per_page=100`,
    );

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

/** Watch-source + control wiring for `gyeoljae watch` on GitHub Issues. */
import type { CandidateApproval } from "../approval/validator.js";
import type { LedgerControl, WatchItem } from "../watch/orchestrator.js";

export class GitHubWatchSource {
  constructor(
    private readonly api: GitHubApi,
    private readonly owner: string,
    private readonly repo: string,
    private readonly blockedLabel = "blocked",
  ) {}

  async openItems(): Promise<WatchItem[]> {
    const issues = await getAllPages<GitHubIssue>(
      this.api,
      `/repos/${this.owner}/${this.repo}/issues?state=open&per_page=100`,
    );

    const items: WatchItem[] = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const comments = await getAllPages<{ body?: string }>(
        this.api,
        `/repos/${this.owner}/${this.repo}/issues/${issue.number}/comments?per_page=100`,
      );
      items.push({
        ref: `${this.owner}/${this.repo}#${issue.number}`,
        title: issue.title,
        status: issue.labels.some((label) => label.name === this.blockedLabel) ? "blocked" : "open",
        comment_bodies: comments.map((comment) => comment.body ?? ""),
        url: issue.html_url,
      });
    }
    return items;
  }
}

export class GitHubLedgerControl implements LedgerControl {
  constructor(
    private readonly api: GitHubApi,
    private readonly ledger: GitHubIssuesLedger,
    private readonly blockedLabel = "blocked",
  ) {}

  async transition(ref: string, to: "blocked" | "done", note: string): Promise<void> {
    const issue = parseLedgerRef(ref);
    const base = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
    if (to === "blocked") {
      await this.api.request("POST", `${base}/labels`, { labels: [this.blockedLabel] });
    } else {
      await this.api.request("PATCH", base, { state: "closed" });
    }
    await this.ledger.comment(ref, `${note} -> ${to}`);
  }

  async recordApproval(ref: string, candidate: CandidateApproval): Promise<void> {
    await this.ledger.comment(
      ref,
      `Chat approval recorded\n\nApproved via reply in request thread ${candidate.thread_key} (reply ts ${candidate.reply_ts}, approver ${candidate.approver ?? "unknown"}). Validation: exact short approval in the pending request thread; scope unchanged. Authority: this ledger record.`,
    );
  }
}
