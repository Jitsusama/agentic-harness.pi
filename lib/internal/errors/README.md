# Errors

Telling one failure from another, so a caller retries what a later
try could get past and lets the rest through.

## Files

- **`model-failure.ts`**: whether a failed model call is one a
  later try could get past, by pi's own judgement, and the wait
  before each try, for `model-retry-workflow` and the compaction
  summary.
- **`stale.ts`**: telling pi's stale-context error, after a reload
  or session switch, from any other.
