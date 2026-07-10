const SLACK_API_BASE = "https://slack.com/api";

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages: SlackApiMessage[];
}

export interface SlackApiMessage {
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  reply_count?: number;
  edited?: { ts: string };
  files?: Array<{ id: string; name?: string; mimetype?: string; size?: number }>;
  [key: string]: unknown;
}

/** Minimal read-only Slack Web API client. No SDK dependency. */
export class SlackClient {
  constructor(private readonly token: string) {}

  history(channelId: string, limit: number): Promise<SlackApiMessage[]> {
    return this.call("conversations.history", { channel: channelId, limit: String(limit) });
  }

  replies(channelId: string, threadTs: string, limit: number): Promise<SlackApiMessage[]> {
    return this.call("conversations.replies", { channel: channelId, ts: threadTs, limit: String(limit) });
  }

  private async call(method: string, params: Record<string, string>): Promise<SlackApiMessage[]> {
    const url = `${SLACK_API_BASE}/${method}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await response.json()) as SlackHistoryResponse;
    if (!body.ok) throw new Error(`Slack API ${method} failed: ${body.error ?? "unknown_error"}`);
    return body.messages;
  }
}
