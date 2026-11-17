# Cache

The model's prompt cache: what its prices make a compaction cost, and
keeping an idle session's hour-long entry warm, for
`compaction-workflow` and the pi host's parked sessions.

## Files

- **`cache-prices.ts`**: the cache prices a compaction is weighed
  at, from the active model's own rates.
- **`cache-warming.ts`**: the rules for keeping an idle session's
  hour-long cache entry warm: when a warm falls due, which requests
  may be replayed, and when a warm missed its prefix.
- **`calls.ts`**: whether a call is on, as `a-call-is-on` says, for
  work that would cut into one, such as a warm's upload.
- **`warming-carry.ts`**: an idle session's warming as kept on disk
  while no pi runs it, which a pi host warms on while the session is
  parked, and the warms it sent for the session's next start to record.
