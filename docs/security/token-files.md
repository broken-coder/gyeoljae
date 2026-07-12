# Token-file hardening

gyeoljae keeps chat and ledger credentials out of agents. Only the bridge process reads token files, and it never needs to copy their values into an issue, notification, fixture, or log.

`readTokenFile` parses a caller-supplied path; it does not enforce filesystem policy. Treat the following checks as deployment preflight requirements.

## File requirements

- Run the bridge as a dedicated, unprivileged service account.
- Store each token in a regular file owned by that service account.
- Set the file mode to `0600` and the parent directory to `0700`.
- Reject symbolic links before startup. Verify the path with `lstat`, then verify the opened file's owner and mode with `fstat` to avoid a check/open race.
- Mount token files read-only in containers. Validate the host file before mounting it; a read-only mount does not make an unsafe source path trustworthy.
- Use separate files for the Slack bot token, Slack app-level token, and GitHub token so each can be rotated and revoked independently.

A supervisor or entrypoint should fail closed when the path is a symlink, is not a regular file, has an unexpected owner, or grants any group/world permissions. On Linux, a basic operator check looks like:

```bash
test -f "$TOKEN_FILE"
test ! -L "$TOKEN_FILE"
test "$(stat -c '%u' "$TOKEN_FILE")" -eq "$(id -u gyeoljae)"
test "$(stat -c '%a' "$TOKEN_FILE")" = "600"
```

Use the platform's equivalent `stat` flags on non-Linux hosts. These shell checks are useful preflight evidence; a long-running supervisor should still open and validate the same file descriptor before launching the bridge.

## Rotation

1. Create the replacement as a new regular file in the same protected directory, owned by the service account with mode `0600`.
2. Validate the new credential with a minimal read-only API call from the bridge identity. Do not print the value.
3. Replace the configured token file, restart the affected bridge process, and verify one read-only poll or connection.
4. Revoke the old credential only after the new process is healthy.
5. Record the rotation time and credential identifier in the deployment ledger, never the credential value.

If a provider offers overlapping credentials, use the overlap window. If it does not, schedule a bounded restart and accept a short retry window. Slack bot and app-level tokens are separate capabilities; rotating one does not rotate the other.

## Incident response

If a token may have reached a log, issue, fixture, shell history, or agent context, treat it as exposed: stop the affected writer, revoke and replace the token, remove the exposed artifact from active surfaces, and review audit logs. Redaction after exposure is not a substitute for rotation.
