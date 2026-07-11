#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { validateApprovalReply, type ApprovalReply, type PendingRequest } from "../approval/validator.js";
import { SocketModeListener } from "../slack/socket.js";
import { readTokenFile } from "../slack/token.js";

/**
 * Approval-reply listener.
 *
 * --fixture <file>: dry-run — replay recorded events through the validator,
 *   no network. Fixture: { "pending": [{thread_key, ledger_ref}],
 *   "events": [{channel, thread_ts, ts, user, text}] }
 * --app-token-file: live Socket Mode (shadow deployments only) — candidates
 *   are appended to a LOCAL file; nothing is written to any ledger or chat.
 */
export async function runListen(argv: string[]): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    options: {
      fixture: { type: "string" },
      "app-token-file": { type: "string" },
      "pending-file": { type: "string" },
      out: { type: "string" },
    },
  });
  const outPath = values.out;
  if (!outPath) throw new Error("Missing required option: --out");
  mkdirSync(dirname(outPath), { recursive: true });

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
      const candidate = validateApprovalReply(reply, pending);
      counts[candidate.verdict] = (counts[candidate.verdict] ?? 0) + 1;
      if (candidate.verdict !== "not-approval") record(candidate);
    }
    return `dry-run: ${fixture.events.length} events -> ${JSON.stringify(counts)} -> ${outPath}`;
  }

  if (values["app-token-file"]) {
    const pendingPath = values["pending-file"];
    if (!pendingPath) throw new Error("Live mode requires --pending-file");
    const pendingList = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingRequest[];
    const pending = new Map(pendingList.map((request) => [request.thread_key, request]));

    const listener = new SocketModeListener({
      appToken: readTokenFile(values["app-token-file"], "xapp-"),
      onEvent: (event) => {
        if (event["type"] !== "message" || typeof event["ts"] !== "string") return;
        const reply: ApprovalReply = {
          channel_id: String(event["channel"] ?? ""),
          ts: String(event["ts"]),
          ...(typeof event["thread_ts"] === "string" ? { thread_ts: event["thread_ts"] } : {}),
          ...(typeof event["user"] === "string" ? { user: event["user"] } : {}),
          ...(typeof event["text"] === "string" ? { text: event["text"] } : {}),
        };
        const candidate = validateApprovalReply(reply, pending);
        if (candidate.verdict !== "not-approval") record(candidate);
      },
    });
    await listener.start();
    return `listening (shadow); candidates -> ${outPath}`;
  }

  throw new Error("Provide --fixture (dry-run) or --app-token-file (live shadow).");
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1) ?? "");
if (invokedDirectly) {
  runListen(process.argv.slice(2))
    .then((summary) => console.log(summary))
    .catch((error: Error) => {
      console.error(`[gyeoljae listen] ${new Date().toISOString()} ${error.message}`);
      process.exit(1);
    });
}
