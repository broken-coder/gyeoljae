#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { Classifier } from "../classifier.js";
import { EnvelopeBuilder, publicEnvelope } from "../envelope.js";
import { SummaryRenderer } from "../renderer.js";
import { ReplayPlanner } from "../replay.js";
import { SlackClient, type SlackApiMessage } from "../slack/client.js";
import { readTokenFile } from "../slack/token.js";
import { ThreadDocumentBuilder, groupThreads } from "../slack/thread-document.js";
import { ShadowStore } from "../store.js";
import type { ClassifiedEnvelope } from "../types.js";

/**
 * One-shot inbound poll: read a channel, emit sanitized envelopes, exit.
 *
 * Interval-runner friendly (cron/launchd): --state-file persists the last
 * acknowledged ts between runs; a failed run aborts without writing partial
 * state and the next interval retries. All writes are local files.
 */
export async function runPoll(argv: string[]): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "channel-id": { type: "string" },
      "token-file": { type: "string" },
      "ledger-ref": { type: "string" },
      limit: { type: "string", default: "50" },
      "max-threads": { type: "string", default: "12" },
      "last-ack-ts": { type: "string" },
      "state-file": { type: "string" },
      store: { type: "string" },
      out: { type: "string" },
    },
  });

  const channelId = required(values["channel-id"], "--channel-id");
  const tokenFile = required(values["token-file"], "--token-file");
  const outPath = required(values.out, "--out");
  const ledgerRef = values["ledger-ref"] ?? null;
  const limit = Number(values.limit);
  const maxThreads = Number(values["max-threads"]);

  const lastAckTs = values["last-ack-ts"] ?? readState(values["state-file"]);
  const client = new SlackClient(readTokenFile(tokenFile));

  let messages = await client.history(channelId, limit);
  if (lastAckTs) messages = new ReplayPlanner(messages, lastAckTs).replayMessages();

  const documents = [];
  const builder = new ThreadDocumentBuilder(channelId, ledgerRef);
  for (const [threadTs, bucket] of [...groupThreads(messages)].slice(0, maxThreads)) {
    const parent = bucket.find((message) => message.ts === threadTs);
    const full: SlackApiMessage[] =
      parent && (parent.reply_count ?? 0) > 0 ? await client.replies(channelId, threadTs, limit) : bucket;
    documents.push(builder.build(threadTs, full));
  }

  const envelopes = documents.flatMap((document) => new EnvelopeBuilder(document).build());
  const classified: ClassifiedEnvelope[] = new Classifier(envelopes).classify();
  const publicEnvelopes = classified.map((envelope) => publicEnvelope(envelope) as ClassifiedEnvelope);

  const payload = {
    ledger_ref: ledgerRef,
    generated_at: new Date().toISOString(),
    mode: "shadow-live-one-shot",
    last_ack_ts: lastAckTs ?? null,
    channel_id: channelId,
    thread_count: documents.length,
    envelopes: publicEnvelopes,
    ledger_comment: new SummaryRenderer(publicEnvelopes).render(),
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  if (values.store) {
    const store = new ShadowStore(values.store);
    for (const envelope of classified) store.upsert(envelope);
  }
  writeState(values["state-file"], lastAckTs, publicEnvelopes);

  return `Wrote ${publicEnvelopes.length} sanitized envelopes from ${documents.length} thread(s) to ${outPath}`;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
}

function readState(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as { last_ack_ts?: string };
  return state.last_ack_ts;
}

/** Advances to the newest processed ts; an empty run keeps the previous ack. */
function writeState(
  path: string | undefined,
  previousAck: string | undefined,
  envelopes: ClassifiedEnvelope[],
): void {
  if (!path) return;
  const newest = envelopes.map((envelope) => envelope.message_ts).sort().at(-1);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ last_ack_ts: newest ?? previousAck ?? null }, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1) ?? "");
if (invokedDirectly) {
  runPoll(process.argv.slice(2))
    .then((summary) => console.log(summary))
    .catch((error: Error) => {
      console.error(`[gyeoljae poll] ${new Date().toISOString()} ${error.message}`);
      process.exit(1);
    });
}
