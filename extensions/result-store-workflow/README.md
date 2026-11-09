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

```text
result_query handle:result-1a2b3c4d5e6f7a8b expression:"$.nodes[?(@.role=='button')].name"
```

The alternative, a query verb inside each family, fragments the
language and collides with names that already mean something else:
`browser_see kind=query` searches a live page, not a stored answer.

## Lifetime

Each session has a stable directory under the XDG state tree, independent
of its process id, with its own 256 MiB quota. Writers and result_query
pass caller context when opening it. Opening a store names the directory
without creating it; a successful payload write records ownership.

Plain-pi quit removes only the caller's results. Reload, new session,
resume and fork keep them. A hosted quit retains results too, because a
host stop emits quit before those same conversations resume. Hosted
handles remain readable through a new host owner and boot.

Owner records carry the process start time, boot and kernel start ticks
when available, plus the hosted conversation. Proven dead plain-pi owners
are reaped; missing or corrupt ownership is preserved. A dead hosted owner's
results are reaped only when every host roster reads cleanly and none
holds the conversation; a missing, unreadable or malformed roster keeps
them.

Startup copies only branch-cited handles from the old pid-only and
pid/session layouts. Originals remain for other pre-upgrade conversations
and dead-pid reaping. Adoption markers prevent an upgrade from resurrecting
legacy payloads already evicted under quota.

A handle can expire after plain-pi quit, proven abandonment or quota
eviction. The query reports expiration rather than an empty answer that
reads like "no data".

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
| `render.ts` | How a query reads in the transcript |

The store, the query language, the digest and the citation rule
all live in the package's [result library][result]; this extension is
its session-lifetime adapter.

[result]: ../../lib/core/result/index.ts
