import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ChatAdapter } from "../types.js";

/**
 * Shadow-stage chat adapter: appends would-be notifications to a local file
 * instead of posting anywhere. Lets a deployment validate the outbound loop
 * end-to-end before granting the bridge any chat write scope.
 */
export class FileChatAdapter implements ChatAdapter {
  constructor(private readonly path: string) {}

  async notify(channel: string, body: string): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), channel, body })}\n`);
  }
}
