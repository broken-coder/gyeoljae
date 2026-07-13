#!/usr/bin/env node
/**
 * Sanitization gate: fails if anything that looks like a real credential or
 * private infrastructure identifier appears in tracked files.
 *
 * Generic patterns only — project-specific denylists belong in private
 * deployments, not here.
 */
import { execFileSync } from "node:child_process";

const PATTERNS = [
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

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file && !file.startsWith("scripts/sanitize-check"));

let failures = 0;
for (const file of files) {
  const content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8" });
  for (const { name, regex } of PATTERNS) {
    const match = content.match(regex);
    if (match) {
      console.error(`FAIL ${file}: ${name} pattern matched`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`\nSanitization check failed with ${failures} finding(s).`);
  process.exit(1);
}
console.log(`Sanitization check passed (${files.length} files).`);
