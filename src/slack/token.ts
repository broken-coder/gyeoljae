import { readFileSync } from "node:fs";

/**
 * Reads a bot token from a caller-supplied file, in place.
 *
 * Accepts either a raw `xoxb-` token or a JSON document containing one at
 * any depth (the shape secret managers write varies). The token is returned
 * to the caller and must never be logged, persisted, or echoed in errors.
 */
export function readTokenFile(path: string): string {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("xoxb-")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Unsupported token file format: not a raw xoxb- token and not valid JSON.");
  }
  const token = findBotToken(parsed);
  if (token) return token;
  throw new Error("Unsupported token file format: no bot token field found in JSON.");
}

function findBotToken(node: unknown): string | null {
  if (typeof node === "string") return node.startsWith("xoxb-") ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findBotToken(item);
      if (found) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findBotToken(value);
      if (found) return found;
    }
  }
  return null;
}
