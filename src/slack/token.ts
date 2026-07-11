import { readFileSync } from "node:fs";

/**
 * Reads a bot token from a caller-supplied file, in place.
 *
 * Accepts either a raw `xoxb-` token or a JSON document containing one at
 * any depth (the shape secret managers write varies). The token is returned
 * to the caller and must never be logged, persisted, or echoed in errors.
 */
export function readTokenFile(path: string, prefix = "xoxb-"): string {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith(prefix)) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Unsupported token file format: not a raw ${prefix} token and not valid JSON.`);
  }
  const token = findToken(parsed, prefix);
  if (token) return token;
  throw new Error(`Unsupported token file format: no ${prefix} token field found in JSON.`);
}

function findToken(node: unknown, prefix: string): string | null {
  if (typeof node === "string") return node.startsWith(prefix) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findToken(item, prefix);
      if (found) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findToken(value, prefix);
      if (found) return found;
    }
  }
  return null;
}
