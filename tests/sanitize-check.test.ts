import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sanitizer = join(process.cwd(), "scripts", "sanitize-check.mjs");

test("sanitize gate rejects real issue-tracker identifiers", () => {
  const issueId = ["OPS", "123"].join("-");
  const result = runSanitizer(`Private tracker reference: ${issueId}\n`);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /issue-tracker identifier/);
});

test("sanitize gate permits documented EX example identifiers", () => {
  const result = runSanitizer("Generic fixture reference: EX-1\n");

  assert.equal(result.status, 0, result.stderr);
});

test("sanitize gate does not mistake regex character classes for issue identifiers", () => {
  const result = runSanitizer("const pattern = /[A-Z0-9.]+/;\n");

  assert.equal(result.status, 0, result.stderr);
});

function runSanitizer(content: string) {
  const repo = mkdtempSync(join(tmpdir(), "gyeoljae-sanitize-test-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), content);
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    return spawnSync(process.execPath, [sanitizer], { cwd: repo, encoding: "utf8" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
