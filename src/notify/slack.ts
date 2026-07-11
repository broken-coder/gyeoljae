import type { ChatAdapter } from "../types.js";

const SLACK_API_BASE = "https://slack.com/api";

export interface PostReceipt {
  channel: string;
  ts: string;
}

export type PostFn = (token: string, channel: string, text: string) => Promise<PostReceipt>;

export async function defaultPost(token: string, channel: string, text: string): Promise<PostReceipt> {
  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string; channel?: string; ts?: string };
  if (!body.ok || !body.ts || !body.channel) {
    throw new Error(`chat.postMessage failed: ${body.error ?? "unknown_error"}`);
  }
  return { channel: body.channel, ts: body.ts };
}

/**
 * Live chat adapter. The bridge is the ONLY holder of this capability;
 * callers must pass content-free bodies (refs/status/title — the Notifier's
 * renderer guarantees this for ledger events).
 *
 * Returns the posted message receipt so deployments can register the
 * notification's own thread as the approval-reply thread.
 */
export class SlackChatAdapter implements ChatAdapter {
  constructor(
    private readonly token: string,
    private readonly post: PostFn = defaultPost,
  ) {}

  async notify(channel: string, body: string): Promise<PostReceipt> {
    return this.post(this.token, channel, body);
  }
}
