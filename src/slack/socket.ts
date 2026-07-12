/**
 * Slack Socket Mode listener.
 *
 * Real-time inbound without a public endpoint: opens a WebSocket via
 * apps.connections.open (app-level token, read in place like all tokens),
 * acks every envelope, and hands event payloads to a callback. Transport
 * pieces are injectable so tests run without a network.
 *
 * The listener carries no policy: validation and routing stay in the
 * approval validator and the existing inbound pipeline.
 */

const SLACK_API_BASE = "https://slack.com/api";

export interface SocketLike {
  addEventListener(type: "open" | "message" | "close", listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;
export type OpenUrl = (appToken: string) => Promise<string>;

export interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  reason?: string;
  payload?: { event?: Record<string, unknown> };
}

export async function defaultOpenUrl(appToken: string): Promise<string> {
  const response = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  });
  const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
  if (!body.ok || !body.url) {
    throw new Error(`apps.connections.open failed: ${body.error ?? "unknown_error"}`);
  }
  return body.url;
}

export interface ListenerOptions {
  appToken: string;
  onEvent: (event: Record<string, unknown>) => void | Promise<void>;
  openUrl?: OpenUrl;
  socketFactory?: SocketFactory;
  /** Delay before reconnect attempts; kept small in tests. */
  reconnectDelayMs?: number;
  /** Called once per (re)connection, mainly for tests/telemetry. */
  onConnect?: (connectionCount: number) => void;
}

export class SocketModeListener {
  private stopped = false;
  private socket: SocketLike | null = null;
  private connections = 0;

  constructor(private readonly options: ListenerOptions) {}

  /** Resolves after the first connection is established. */
  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const openUrl = this.options.openUrl ?? defaultOpenUrl;
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

    const url = await openUrl(this.options.appToken);
    const socket = factory(url);
    this.socket = socket;
    this.connections += 1;
    this.options.onConnect?.(this.connections);

    socket.addEventListener("message", (event) => {
      void this.handleMessage(socket, String(event.data ?? ""));
    });
    socket.addEventListener("close", () => {
      void this.scheduleReconnect();
    });
  }

  private async handleMessage(socket: SocketLike, raw: string): Promise<void> {
    let envelope: SocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketEnvelope;
    } catch {
      return; // non-JSON frames are ignored; the protocol is JSON-only
    }

    // Ack before the callback to meet Slack's response window. A process crash
    // after this send but before callback persistence can lose the candidate;
    // the current Socket Mode path has no automatic replay for acked envelopes.
    if (envelope.envelope_id) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type === "disconnect") {
      socket.close();
      return;
    }
    if (envelope.type === "events_api" && envelope.payload?.event) {
      await this.options.onEvent(envelope.payload.event);
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs ?? 1000));
    await this.connect();
  }
}
