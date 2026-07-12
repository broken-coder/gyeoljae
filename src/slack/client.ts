const SLACK_API_BASE = "https://slack.com/api";

/**
 * Hard page cap per read. A window that exceeds it aborts the run instead of
 * silently truncating, so poll state never advances past unseen messages.
 */
const MAX_PAGES = 100;

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages: SlackApiMessage[];
  response_metadata?: { next_cursor?: string };
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

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  json(): Promise<unknown>;
}>;

/** Minimal read-only Slack Web API client. No SDK dependency. */
export class SlackClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly token: string,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Reads channel history. Without `oldest` this is a single newest-first
   * page of `limit` messages (interval polling). With `oldest` (replay after
   * an outage) it follows cursor pagination until the window since `oldest`
   * is fully read, so no message between last ack and now is missed.
   */
  history(channelId: string, limit: number, oldest?: string): Promise<SlackApiMessage[]> {
    const params: Record<string, string> = { channel: channelId, limit: String(limit) };
    if (oldest === undefined) return this.page("conversations.history", params);
    return this.paginate("conversations.history", { ...params, oldest });
  }

  /** Reads a full thread, following cursor pagination past `limit`-sized pages. */
  replies(channelId: string, threadTs: string, limit: number): Promise<SlackApiMessage[]> {
    return this.paginate("conversations.replies", { channel: channelId, ts: threadTs, limit: String(limit) });
  }

  private async paginate(method: string, params: Record<string, string>): Promise<SlackApiMessage[]> {
    const messages: SlackApiMessage[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.call(method, cursor === undefined ? params : { ...params, cursor });
      messages.push(...body.messages);
      cursor = body.response_metadata?.next_cursor || undefined;
      if (!cursor) return messages;
    }
    throw new Error(`Slack API ${method} exceeded ${MAX_PAGES} pages; aborting so state does not advance past unread messages.`);
  }

  private async page(method: string, params: Record<string, string>): Promise<SlackApiMessage[]> {
    return (await this.call(method, params)).messages;
  }

  private async call(method: string, params: Record<string, string>): Promise<SlackHistoryResponse> {
    const url = `${SLACK_API_BASE}/${method}?${new URLSearchParams(params)}`;
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await response.json()) as SlackHistoryResponse;
    if (!body.ok) throw new Error(`Slack API ${method} failed: ${body.error ?? "unknown_error"}`);
    return body;
  }
}
