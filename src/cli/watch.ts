#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import type { CandidateApproval } from "../approval/validator.js";
import { GitHubLedgerControl, GitHubRestApi, GitHubIssuesLedger, GitHubWatchSource } from "../ledger/github.js";
import { FileChatAdapter } from "../notify/adapters.js";
import { Notifier } from "../notify/notifier.js";
import { WatchOrchestrator } from "../watch/orchestrator.js";
import { isInvokedDirectly } from "./main.js";

/**
 * One-shot watch pass over a GitHub Issues ledger.
 *
 * Shadow by default: notifications land in a local outbox file. Wire a real
 * chat adapter only after your deployment's own outbound approval step.
 */
export async function runWatch(argv: string[]): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      "token-file": { type: "string" },
      "state-dir": { type: "string" },
      candidates: { type: "string" },
    },
  });
  const repoArg = values.repo;
  const tokenFile = values["token-file"];
  const stateDir = values["state-dir"];
  if (!repoArg || !tokenFile || !stateDir) {
    throw new Error("Required: --repo owner/name --token-file <path> --state-dir <dir>");
  }
  const [owner, repo] = repoArg.split("/");
  if (!owner || !repo) throw new Error(`Invalid --repo (expected owner/name): ${repoArg}`);

  mkdirSync(stateDir, { recursive: true });
  const statePath = `${stateDir}/processed.json`;
  const keys = new Set<string>(existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as string[]) : []);
  const state = {
    has: (key: string) => keys.has(key),
    add: (key: string) => {
      keys.add(key);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify([...keys], null, 2)}\n`);
    },
  };

  const api = new GitHubRestApi(readFileSync(tokenFile, "utf8").trim());
  const orchestrator = new WatchOrchestrator(
    new GitHubLedgerControl(api, new GitHubIssuesLedger(api)),
    new Notifier(new FileChatAdapter(`${stateDir}/outbox.jsonl`), "#watch-shadow", `${stateDir}/notified.json`),
    state,
    { closedStatuses: ["closed", "done", "canceled"] },
  );

  const items = await new GitHubWatchSource(api, owner, repo).openItems();
  const candidates: CandidateApproval[] =
    values.candidates && existsSync(values.candidates)
      ? readFileSync(values.candidates, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as CandidateApproval)
      : [];

  const summary = await orchestrator.pass(items, candidates);
  return `watch pass: ${JSON.stringify(summary)} (${items.length} open items)`;
}

if (isInvokedDirectly(import.meta.url)) {
  runWatch(process.argv.slice(2))
    .then((summary) => console.log(summary))
    .catch((error: Error) => {
      console.error(`[gyeoljae watch] ${new Date().toISOString()} ${error.message}`);
      process.exit(1);
    });
}
