#!/usr/bin/env node
/**
 * Payload sanitization gate: scans exactly the files `npm pack` would ship
 * (from the working tree, including built `dist/` output that the git-index
 * check never sees). Runs in `prepack`, so a tarball can never carry a secret
 * that the tracked-file check missed.
 */
import { execFileSync } from "node:child_process";

import { scanFile } from "./sanitize-check.mjs";

// List the packed files without triggering lifecycle scripts (no prepack recursion).
const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);

const failures = files.reduce((sum, path) => sum + scanFile(path), 0);
if (failures > 0) {
  console.error(`\nPayload sanitization failed with ${failures} finding(s) across the packed tarball.`);
  process.exit(1);
}
// Success goes to stderr so it never pollutes the stdout of a parent `npm pack --json`.
console.error(`Payload sanitization passed (${files.length} packed files).`);
