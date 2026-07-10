import type { SlackApiMessage } from "./client.js";
import type { SlackFileRef, ThreadDocument, ThreadMessage } from "../types.js";

/**
 * Converts Slack API message payloads into the ThreadDocument shape the
 * EnvelopeBuilder expects. Pure; drops everything except the fields the
 * envelope needs (notably private file URLs never pass through).
 */
export class ThreadDocumentBuilder {
  constructor(
    private readonly channelId: string,
    private readonly ledgerRef: string | null,
  ) {}

  build(threadTs: string, apiMessages: SlackApiMessage[]): ThreadDocument {
    return {
      ledger_ref: this.ledgerRef,
      channel_id: this.channelId,
      thread_ts: threadTs,
      messages: apiMessages.map((message) => this.message(message)),
    };
  }

  private message(api: SlackApiMessage): ThreadMessage {
    const message: ThreadMessage = {
      ts: api.ts,
      text: api.text ?? "",
      files: (api.files ?? []).map((file) => this.fileRef(file)),
    };
    const user = api.user ?? api.bot_id;
    if (user !== undefined) message.user = user;
    if (api.edited?.ts !== undefined) message.edited = { ts: api.edited.ts };
    return message;
  }

  private fileRef(file: { id: string; name?: string; mimetype?: string; size?: number }): SlackFileRef {
    const ref: SlackFileRef = { id: file.id };
    if (file.name !== undefined) ref.name = file.name;
    if (file.mimetype !== undefined) ref.mimetype = file.mimetype;
    if (file.size !== undefined) ref.size = file.size;
    return ref;
  }
}

/** Groups history messages into per-thread buckets, newest thread first. */
export function groupThreads(messages: SlackApiMessage[]): Map<string, SlackApiMessage[]> {
  const grouped = new Map<string, SlackApiMessage[]>();
  for (const message of messages) {
    const root = message.thread_ts ?? message.ts;
    const bucket = grouped.get(root) ?? [];
    bucket.push(message);
    grouped.set(root, bucket);
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)));
}
