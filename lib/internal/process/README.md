# Process

One process's shared state and how its callers take turns.

## Files

- **`async-mutex.ts`**: a FIFO mutex for critical sections within
  one process.
- **`process-global.ts`**: singletons shared across an extension's
  module instances.
- **`single-flight.ts`**: one flight per key, which later callers
  join; work that coalesces, running once more after the run going
  for every call that came during it; and `loadOnce`, through which
  every lazy import loads its module once.
