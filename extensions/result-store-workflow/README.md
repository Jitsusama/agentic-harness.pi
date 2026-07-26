# result-store-workflow

Owns the session's result store and registers the one tool that
queries it.

Tools in this package that can answer with a large payload keep the
whole payload on disk and hand back a bounded view plus a handle.
This extension is the other half of that bargain: `result_query`
turns a handle back into an answer, and the session lifecycle
decides how long a handle is worth citing.

## Why One Tool

The cost of a query language is learning it, and that cost is paid
once only if the language does not change depending on who stored
the payload. A browser page outline, a Slack thread, a Google
document and a language-server reference list are all queried the
same way:

```
result_query handle:result-1a2b3c4d5e6f7a8b expression:"$.nodes[?(@.role=='button')].name"
```

The alternative, a query verb inside each family, fragments the
language and collides with names that already mean something else:
`browser_see kind=query` searches a live page, not a stored answer.

## Lifetime

The store is a directory named for this process. A session that
ends cleanly deletes its own; a session that is killed leaves one
behind, and the next session to start reaps any directory whose
process is gone. Keying on the process id means no bookkeeping has
to survive a crash for the reaper to know what is abandoned.

A handle is therefore good for the session that minted it and no
longer. `result_query` says so plainly when a handle has expired
rather than returning an empty answer that reads like "no data".

## Why `-workflow`

It owns session-scoped state and registers a tool over it. That is
not quite any existing contract: `-integration` bridges an
external service, and there is no service here. `-workflow` is the
closest fit on the strength of the session lifetime, and the
taxonomy's rule is that the primary behavioural contract wins.

## Files

| File | Holds |
|---|---|
| `index.ts` | Tool registration and session lifecycle |
| `store.ts` | The session's store, created once and shared |
| `render.ts` | How a query reads in the transcript |

The store, the query language, the digest and the citation rule
all live in [`lib/result`](../../lib/result/README.md); this
extension is a thin consumer of its own library.
