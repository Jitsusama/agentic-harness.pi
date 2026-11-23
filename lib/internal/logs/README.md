# Logs

Session logs read back, for the sensors that mine them, the governance
distiller and the session's own search.

## Files

- **`session-logs.ts`**: every session log a span holds, those still
  on the machine and those only on Drive, read back through
  session-backup's index one at a time and removed once read, for
  the sensors that mine the logs.
- **`transcript.ts`**: pi's session entries as the plain turns the
  governance distiller reads.
- **`recall.ts`**: searching a session's own log, or reading one
  entry of it, so what a compaction dropped stays within reach.
- **`recall-on-disk.ts`**: the history a rolled-over session left in
  its older logs, marked for one recall a line at a time, so a search
  never holds a whole log.
