#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rootVersion = rootPackage.version;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
for (const [name, target] of Object.entries(rootPackage.bin ?? {})) {
  if (target.startsWith("./") || target.includes("\\")) {
    throw new Error(`${name} must use npm's canonical package-relative bin path.`);
  }
}
const scratch = mkdtempSync(join(tmpdir(), "gyeoljae-package-smoke-"));
const packDir = join(scratch, "pack");
const installDir = join(scratch, "blank-project");
const staleArtifact = join(root, "dist", "src", "stale-package-smoke.js");
mkdirSync(packDir);
mkdirSync(installDir);
mkdirSync(join(root, "dist", "src"), { recursive: true });
writeFileSync(staleArtifact, "export const stale = true;\n");

try {
  const packOutput = execFileSync(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDir],
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename, files }] = JSON.parse(packOutput);
  if (files.some((file) => file.path === "dist/src/stale-package-smoke.js")) {
    throw new Error("Packed tarball contains a stale dist artifact.");
  }
  const forbiddenEntry = files.find((file) => /^(src|tests|scripts)\//.test(file.path));
  if (forbiddenEntry) throw new Error(`Packed tarball contains excluded source: ${forbiddenEntry.path}`);
  const tarball = join(packDir, filename);

  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    { flag: "wx" },
  );
  execFileSync(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    { cwd: installDir, stdio: "pipe" },
  );

  const internalImport = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'import("gyeoljae/slack/token")'],
    { cwd: installDir, encoding: "utf8" },
  );
  if (internalImport.status === 0 || !internalImport.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) {
    throw new Error("Internal package subpaths must not be importable.");
  }

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
        'import { NudgeServer } from "gyeoljae/notify/nudge";',
        'import { SlackChatAdapter } from "gyeoljae/notify/slack";',
        'await import("gyeoljae/types");',
        'const packageMetadata = await import("gyeoljae/package.json", { with: { type: "json" } });',
        "if (![EnvelopeBuilder, publicEnvelope, Classifier, GitHubRestApi, Notifier, FileChatAdapter, NudgeServer, SlackChatAdapter].every(Boolean)) process.exit(1);",
        `if (packageMetadata.default.version !== ${JSON.stringify(rootVersion)}) process.exit(1);`,
      ].join("\n"),
    ],
    { cwd: installDir, stdio: "pipe" },
  );

  const fixture = join(installDir, "fixture.json");
  const approvers = join(installDir, "approvers.json");
  const output = join(installDir, "candidates.jsonl");
  writeFileSync(approvers, `${JSON.stringify(["U0EXAMPLE001"])}\n`);
  writeFileSync(
    fixture,
    `${JSON.stringify({
      pending: [{ thread_key: "C0EXAMPLE001:1700000000.000100", ledger_ref: "EX-1" }],
      events: [
        {
          channel: "C0EXAMPLE001",
          thread_ts: "1700000000.000100",
          ts: "1700000001.000100",
          user: "U0EXAMPLE001",
          text: "approve",
        },
        {
          channel: "C0EXAMPLE001",
          thread_ts: "1700000000.000100",
          ts: "1700000002.000100",
          user: "U0EXAMPLE002",
          text: "approve",
        },
      ],
    }, null, 2)}\n`,
  );
  const listenResult = spawnSync(
    installedBin("gyeoljae-listen"),
    ["--fixture", fixture, "--approvers-file", approvers, "--out", output],
    installedBinOptions(),
  );
  const candidateLines = existsSync(output) ? readFileSync(output, "utf8") : "";
  if (
    listenResult.status !== 0 ||
    !candidateLines.includes('"verdict":"approved-candidate"') ||
    !candidateLines.includes('"reason":"unauthorized-approver"')
  ) {
    throw new Error("Installed CLI did not produce the expected authorized approval candidate.");
  }

  expectCliFailure("gyeoljae-poll", "Missing required option: --channel-id");
  expectCliFailure("gyeoljae-watch", "Required: --repo owner/name --token-file <path> --state-dir <dir>");

  console.log(`Package smoke passed: ${filename} imports and all three CLIs resolve from a blank project.`);
} finally {
  rmSync(staleArtifact, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}

function installedBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(installDir, "node_modules", ".bin", `${name}${suffix}`);
}

function installedBinOptions() {
  return {
    cwd: installDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  };
}

function expectCliFailure(name, expectedError) {
  const result = spawnSync(installedBin(name), [], installedBinOptions());
  if (result.status !== 1 || !result.stderr.includes(expectedError)) {
    throw new Error(`${name} did not execute its installed CLI entrypoint.`);
  }
}
