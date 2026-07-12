# Local JSON state: single-writer contract

gyeoljae's local JSON checkpoints are intentionally simple rollout storage. Current writes use direct file replacement APIs and are **not atomic**. Concurrent writers to the same path are unsupported.

This applies to:

- poller `--state-file`, `--store`, and `--out` paths;
- watcher `processed.json`, `notified.json`, and local outbox files under `--state-dir`;
- listener candidate output passed with `--out`.

## Required deployment rule

Run exactly one writer per state file or state directory. Prevent overlapping cron runs, configure the service supervisor for a single instance, or hold an external lock for the full command. Separate bridge replicas must use separate state directories; do not point multiple containers at the same volume path.

Examples of acceptable enforcement include a non-overlapping systemd service/timer, `flock` around a cron command, or a scheduler concurrency policy of one. Network filesystems and shared writable volumes do not provide a supported multi-writer mode.

## Failure semantics

- A process exit during a JSON write can leave a truncated file. Stop the writer before repairing or restoring it.
- Polling can replay from the last known-good acknowledgement. Keep the previous checkpoint when recovery evidence is uncertain.
- Notification delivery is **deduplicated at-least-once** and does not guarantee a single remote post. A crash after a remote send but before the local event-key checkpoint can repeat a notification.
- Do not advance or reconstruct a checkpoint merely to silence a parse error; validate the upstream ledger/chat state first.

For high-availability or multi-replica deployments, replace local JSON state with a transactional store and an explicit lease/ownership protocol. That is a separate adapter-level design; shared local files are not a shortcut to it.
