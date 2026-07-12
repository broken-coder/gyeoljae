#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import {
  allowlistAuthorizer,
  validateApprovalReply,
  type ApprovalReply,
  type Authorizer,
  type PendingRequest,
  type ValidateOptions,
} from "../approval/validator.js";
import { DurableInbox } from "../slack/inbox.js";
import { SocketModeListener } from "../slack/socket.js";
import { readTokenFile } from "../slack/token.js";
import { isInvokedDirectly } from "./main.js";

/**
 * Approval-reply listener.
 *
 * --fixture <file>: dry-run — replay recorded events through the validator,
 *   no network. Fixture: { "pending": [{thread_key, ledger_ref}],
 *   "events": [{channel, thread_ts, ts, user, text}] }
 * --app-token-file: live Socket Mode (shadow deployments only) — candidates
 *   are appended to a LOCAL file; nothing is written to any ledger or chat.
 * --approvers-file: JSON array of Slack user ids allowed to approve. Fail-closed:
 *   without it, replies never become approved-candidates (they degrade to
 *   needs-human). Bot/system messages and missing-user replies are always rejected.
 */
export async function runListen(argv: string[]): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    options: {
      fixture: { type: "string" },
      "app-token-file": { type: "string" },
      "pending-file": { type: "string" },
      "approvers-file": { type: "string" },
      "inbox-dir": { type: "string" },
      out: { type: "string" },
    },
  });
  const outPath = values.out;
  if (!outPath) throw new Error("Missing required option: --out");
  mkdirSync(dirname(outPath), { recursive: true });

  // Fail-closed: without an approvers file, no reply can become an
  // approved-candidate (they degrade to needs-human).
  const authorizer: Authorizer | undefined = values["approvers-file"]
    ? allowlistAuthorizer(JSON.parse(readFileSync(values["approvers-file"], "utf8")) as string[])
    : undefined;
  const validateOptions: ValidateOptions = authorizer ? { authorizer } : {};

  const record = (candidate: unknown): void => {
    appendFileSync(outPath, `${JSON.stringify(candidate)}\n`);
  };

  if (values.fixture) {
    const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as {
      pending: PendingRequest[];
      events: Array<{ channel: string; thread_ts?: string; ts: string; user?: string; text?: string }>;
    };
    const pending = new Map(fixture.pending.map((request) => [request.thread_key, request]));
    const counts: Record<string, number> = {};
    for (const event of fixture.events) {
      const reply: ApprovalReply = {
        channel_id: event.channel,
        ts: event.ts,
        ...(event.thread_ts !== undefined ? { thread_ts: event.thread_ts } : {}),
        ...(event.user !== undefined ? { user: event.user } : {}),
        ...(event.text !== undefined ? { text: event.text } : {}),
      };
      const candidate = validateApprovalReply(reply, pending, validateOptions);
      counts[candidate.verdict] = (counts[candidate.verdict] ?? 0) + 1;
      if (candidate.verdict !== "not-approval") record(candidate);
    }
    return `dry-run: ${fixture.events.length} events -> ${JSON.stringify(counts)} -> ${outPath}`;
  }

  if (values["app-token-file"]) {
    const pendingPath = values["pending-file"];
    if (!pendingPath) throw new Error("Live mode requires --pending-file");
    const loadPending = (): Map<string, PendingRequest> => {
      if (!existsSync(pendingPath)) return new Map();
      const pendingList = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingRequest[];
      return new Map(pendingList.map((request) => [request.thread_key, request]));
    };

    // Optional durable inbox: store-then-ack + replay so no acked reply is lost.
    const inbox = values["inbox-dir"] ? new DurableInbox(values["inbox-dir"]) : undefined;

    const processEvent = (event: Record<string, unknown>): void => {
      if (event["type"] !== "message" || typeof event["ts"] !== "string") return;
      const reply: ApprovalReply = {
        channel_id: String(event["channel"] ?? ""),
        ts: String(event["ts"]),
        ...(typeof event["thread_ts"] === "string" ? { thread_ts: event["thread_ts"] } : {}),
        ...(typeof event["user"] === "string" ? { user: event["user"] } : {}),
        ...(typeof event["text"] === "string" ? { text: event["text"] } : {}),
        ...(typeof event["bot_id"] === "string" ? { bot_id: event["bot_id"] } : {}),
        ...(typeof event["subtype"] === "string" ? { subtype: event["subtype"] } : {}),
      };
      // Re-read per event: the watcher appends new request threads while we run.
      const candidate = validateApprovalReply(reply, loadPending(), validateOptions);
      if (candidate.verdict !== "not-approval") record(candidate);
    };

    // Replay any envelope persisted-but-not-processed from a prior crash.
    if (inbox) {
      for (const entry of inbox.pending()) {
        processEvent(entry.event);
        inbox.markProcessed(entry.envelope_id);
      }
    }

    const listener = new SocketModeListener({
      appToken: readTokenFile(values["app-token-file"], "xapp-"),
      ...(inbox
        ? {
            // process-then-ack: record durably, run the side effect, mark done,
            // all before the ack. Validation + a file append is well within
            // Slack's response window. A crash anywhere before markProcessed is
            // replayed on the next start; a redelivery of a processed envelope
            // is a no-op.
            persistBeforeAck: async (envelope): Promise<void> => {
              const id = envelope.envelope_id;
              const event = envelope.payload?.event;
              if (!id || !event) return;
              if (inbox.isProcessed(id)) return;
              inbox.record(id, event);
              processEvent(event);
              inbox.markProcessed(id);
            },
            onEvent: () => {},
          }
        : { onEvent: (event: Record<string, unknown>) => processEvent(event) }),
    });
    await listener.start();
    return `listening (shadow${inbox ? ", durable inbox" : ""}); candidates -> ${outPath}`;
  }

  throw new Error("Provide --fixture (dry-run) or --app-token-file (live shadow).");
}

if (isInvokedDirectly(import.meta.url)) {
  runListen(process.argv.slice(2))
    .then((summary) => console.log(summary))
    .catch((error: Error) => {
      console.error(`[gyeoljae listen] ${new Date().toISOString()} ${error.message}`);
      process.exit(1);
    });
}
