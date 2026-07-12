import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolves npm-created bin symlinks before comparing the entrypoint. */
export function isInvokedDirectly(metaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
