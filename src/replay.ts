/**
 * Compares two Slack-style timestamps ("1700000000.000100") as
 * (seconds, sequence) integer tuples, not as strings or floats.
 */
export function compareTs(left: string, right: string): number {
  const [lSec = 0, lSeq = 0] = left.split(".").map(Number);
  const [rSec = 0, rSeq = 0] = right.split(".").map(Number);
  if (lSec !== rSec) return lSec - rSec;
  return lSeq - rSeq;
}

/**
 * Outage recovery: instead of a durable local queue, re-read chat history
 * and process only messages after the last acknowledged timestamp.
 * Idempotent upserts make replay safe to repeat.
 */
export class ReplayPlanner<T extends { ts: string }> {
  constructor(
    private readonly messages: T[],
    private readonly lastAckTs: string,
  ) {}

  replayMessages(): T[] {
    return this.messages
      .filter((message) => compareTs(message.ts, this.lastAckTs) > 0)
      .sort((a, b) => compareTs(a.ts, b.ts));
  }
}
