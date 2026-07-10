import { createServer, type Server } from "node:http";

/**
 * Local nudge endpoint: agents on the same host POST /nudge after writing a
 * ledger entry, and the bridge checks the ledger within seconds instead of
 * waiting for the next poll interval.
 *
 * Deliberately minimal and trust-poor:
 * - Binds to 127.0.0.1 only; never expose it.
 * - The request carries no payload that matters — a nudge means "check the
 *   ledger now", and the ledger stays the single source of truth. Whatever
 *   body is sent is ignored, so a malicious nudge can at worst cause one
 *   extra ledger read.
 * - Bursts are debounced into a single check.
 */
export class NudgeServer {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onNudge: () => void,
    private readonly debounceMs = 500,
  ) {}

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        if (request.method === "POST" && request.url === "/nudge") {
          this.scheduleNudge();
          response.writeHead(202).end("nudged\n");
          return;
        }
        response.writeHead(404).end();
      });
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server!.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.server?.close();
  }

  private scheduleNudge(): void {
    if (this.timer) return; // burst already scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onNudge();
    }, this.debounceMs);
  }
}
