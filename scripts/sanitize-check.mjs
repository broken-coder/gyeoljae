#!/usr/bin/env node
/**
 * Sanitization gate: fails if anything that looks like a real credential or
 * private infrastructure identifier appears in tracked files. Reads file
 * content from the WORKING TREE (not the git index), so dirty tracked changes
 * are caught before they can ship. See sanitize-payload.mjs for the packaged
 * tarball (which also covers built, untracked dist output).
 *
 * Generic patterns only — project-specific denylists belong in private
 * deployments, not here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const PATTERNS = [
  { name: "Slack token", regex: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "Slack app-level token", regex: /xapp-1-[0-9A-Za-z-]{10,}/ },
  { name: "GitHub token", regex: /gh[pousr]_[0-9A-Za-z]{20,}/ },
  { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "CGNAT/Tailscale address", regex: /\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  {
    name: "issue-tracker identifier",
    regex: /(?<![A-Z0-9_-])(?!(?:EX|CVE)-)[A-Z][A-Z0-9]{1,9}-\d+(?![A-Z0-9_-])/,
  },
];

/** Returns the number of pattern hits found in the file at `path`, logging each. */
export function scanFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return 0; // unreadable/binary paths are not scanned here
  }
  let hits = 0;
  for (const { name, regex } of PATTERNS) {
    if (regex.test(content)) {
      console.error(`FAIL ${path}: ${name} pattern matched`);
      hits += 1;
    }
  }
  return hits;
}

// Run as a CLI: scan every tracked file's working-tree content.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !file.startsWith("scripts/sanitize-check"));

  const failures = files.reduce((sum, file) => sum + scanFile(file), 0);
  if (failures > 0) {
    console.error(`\nSanitization check failed with ${failures} finding(s).`);
    process.exit(1);
  }
  console.log(`Sanitization check passed (${files.length} files, working tree).`);
}
