import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { publicEnvelope } from "./envelope.js";
import type { Envelope } from "./types.js";

type StoredEnvelope = Omit<Envelope, "shadow_source_text">;

/**
 * File-backed idempotent envelope store.
 *
 * Semantics ported from the Ruby golden spec:
 * - Upserts by dedup_key: retries and replays never create duplicates.
 * - Internal-only fields (shadow_source_text) are stripped before persisting.
 * - An edit (changed edited_ts) increments version by exactly one over the
 *   stored record; re-upserting the same edit keeps the stored version.
 * - Records are kept sorted by message_ts (lexicographic, wire-compatible
 *   with the Ruby store file).
 */
export class ShadowStore {
  constructor(private readonly path: string) {}

  records(): StoredEnvelope[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")) as StoredEnvelope[];
  }

  upsert(envelope: Envelope): void {
    const sanitized = publicEnvelope(envelope) as StoredEnvelope;
    const byKey = new Map(this.records().map((record) => [record.dedup_key, record]));
    const existing = byKey.get(sanitized.dedup_key);

    sanitized.version = this.nextVersion(sanitized, existing);
    byKey.set(sanitized.dedup_key, sanitized);

    const sorted = [...byKey.values()].sort((a, b) =>
      a.message_ts < b.message_ts ? -1 : a.message_ts > b.message_ts ? 1 : 0,
    );
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(sorted, null, 2)}\n`);
  }

  private nextVersion(incoming: StoredEnvelope, existing: StoredEnvelope | undefined): number {
    if (existing === undefined) return incoming.version ?? 1;
    if (incoming.edited_ts === existing.edited_ts) return existing.version ?? 1;
    return (existing.version ?? 1) + 1;
  }
}
