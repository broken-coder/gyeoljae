#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "gyeoljae-package-smoke-"));
const packDir = join(scratch, "pack");
const installDir = join(scratch, "blank-project");
mkdirSync(packDir);
mkdirSync(installDir);

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packDir],
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(packDir, filename);

  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    { flag: "wx" },
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    { cwd: installDir, stdio: "pipe" },
  );

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { EnvelopeBuilder } from "gyeoljae";',
        'import { publicEnvelope } from "gyeoljae/envelope";',
        'import { Classifier } from "gyeoljae/classifier";',
        'import { GitHubRestApi } from "gyeoljae/ledger/github";',
        'import { Notifier } from "gyeoljae/notify/notifier";',
        'import { FileChatAdapter } from "gyeoljae/notify/adapters";',
        "if (![EnvelopeBuilder, publicEnvelope, Classifier, GitHubRestApi, Notifier, FileChatAdapter].every(Boolean)) process.exit(1);",
      ].join("\n"),
    ],
    { cwd: installDir, stdio: "pipe" },
  );

  const fixture = join(installDir, "fixture.json");
  const output = join(installDir, "candidates.jsonl");
  writeFileSync(
    fixture,
    `${JSON.stringify({
      pending: [{ thread_key: "C0EXAMPLE001:1700000000.000100", ledger_ref: "EX-1" }],
      events: [{
        channel: "C0EXAMPLE001",
        thread_ts: "1700000000.000100",
        ts: "1700000001.000100",
        user: "U0EXAMPLE001",
        text: "approve",
      }],
    }, null, 2)}\n`,
  );
  execFileSync(
    join(installDir, "node_modules", ".bin", "gyeoljae-listen"),
    ["--fixture", fixture, "--out", output],
    { cwd: installDir, stdio: "pipe" },
  );
  if (!existsSync(output) || !readFileSync(output, "utf8").includes('"verdict":"approved-candidate"')) {
    throw new Error("Installed CLI did not produce the expected approval candidate.");
  }

  console.log(`Package smoke passed: ${filename} imports and CLI resolve from a blank project.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
