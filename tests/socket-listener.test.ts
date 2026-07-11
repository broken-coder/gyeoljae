import assert from "node:assert/strict";
import { test } from "node:test";

import { SocketModeListener, type SocketLike } from "../src/slack/socket.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function envelope(id: string, event: Record<string, unknown>): string {
  return JSON.stringify({ type: "events_api", envelope_id: id, payload: { event } });
}

test("acks every envelope and forwards events", async () => {
  const sockets: FakeSocket[] = [];
  const events: Array<Record<string, unknown>> = [];
  const listener = new SocketModeListener({
    appToken: "xapp-test",
    onEvent: (event) => {
      events.push(event);
    },
    openUrl: async () => "wss://fake",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 1,
  });

  await listener.start();
  sockets[0]!.emit("message", { data: JSON.stringify({ type: "hello" }) });
  sockets[0]!.emit("message", { data: envelope("env-1", { type: "message", ts: "1.0", text: "hi" }) });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(events, [{ type: "message", ts: "1.0", text: "hi" }]);
  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), { envelope_id: "env-1" });
  listener.stop();
});

test("disconnect frame triggers reconnect with a fresh url; stop ends the loop", async () => {
  const sockets: FakeSocket[] = [];
  let connections = 0;
  const listener = new SocketModeListener({
    appToken: "xapp-test",
    onEvent: () => {},
    openUrl: async () => "wss://fake",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 1,
    onConnect: (count) => {
      connections = count;
    },
  });

  await listener.start();
  sockets[0]!.emit("message", { data: JSON.stringify({ type: "disconnect", reason: "refresh_requested", envelope_id: "env-d" }) });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(connections, 2, "should reconnect after a disconnect frame");
  listener.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connections, 2, "stop must end the reconnect loop");
});

test("non-JSON frames are ignored without crashing", async () => {
  const sockets: FakeSocket[] = [];
  const listener = new SocketModeListener({
    appToken: "xapp-test",
    onEvent: () => {
      throw new Error("should not be called");
    },
    openUrl: async () => "wss://fake",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 1,
  });

  await listener.start();
  sockets[0]!.emit("message", { data: "PING not-json" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  listener.stop();
});
